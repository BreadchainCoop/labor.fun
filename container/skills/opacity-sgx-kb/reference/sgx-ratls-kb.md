Opacity SGX / RA-TLS Knowledge Base
Compiled from the sgx-gramine, sgx-ratls, sgx-attestation, and sgx-troubleshooting Agent skills. Facts verified against live Intel/Gramine sources as of 2026-06-11 — re-verify version numbers, URLs, and API shapes before relying on them for real decisions.
Contents
SGX DCAP Attestation (sgx-attestation) — mental model, ecosystem state, quote formats, collateral, TCB policy
Gramine SGX LibOS (sgx-gramine) — manifest syntax, toolchain, deprecations, RA-TLS libs, reproducible MRENCLAVE
SGX RA-TLS (sgx-ratls) — quote-in-cert TLS, custom rustls verifiers, EKM freshness
SGX Troubleshooting (sgx-troubleshooting) — symptom-first triage, error tables, library landmines
Appendix A — check-sgx-env.sh
Appendix B — inspect_quote.py
1. SGX DCAP Attestation
Skill: sgx-attestation — Intel SGX DCAP remote attestation reference.
SGX DCAP Attestation
Staleness check (do this first): Facts below were verified against live Intel/Gramine sources on 2026-06-11. The SGX ecosystem moves fast and Intel renames/relocates repos. Before relying on any version number, URL, API shape, or deprecation status for a real decision, re-verify it online (WebSearch/WebFetch). Prefer official sources: github.com/intel/confidential-computing.sgx (ex linux-sgx), github.com/intel/confidential-computing.tee.dcap (ex SGXDataCenterAttestationPrimitives), download.01.org, api.portal.trustedservices.intel.com, gramine.readthedocs.io. Treat any dated claim older than ~6 months as suspect until re-checked.
Sibling skills: sgx-ratls (quote-in-cert TLS patterns, EKM freshness), sgx-gramine (manifests, signing, RA-TLS libs), sgx-troubleshooting (symptom-to-cause checklists, scripts/check-sgx-env.sh).
1. Mental model
Enclave: CPU-enforced encrypted memory region. The host OS/hypervisor/operator cannot read or tamper with it — but they control everything outside it (env vars, files, network, time).
MRENCLAVE: SHA-256 measurement of the exact enclave contents at load ("hash of the program"). Changes with ANY code, linked-library, or Gramine-manifest change. Pin this to trust specific code.
MRSIGNER: hash of the enclave signing key ("who signed it"). Stable across versions; pin this to trust a vendor's future releases. SGX sealing keys derive from it.
Report: locally verifiable attestation struct (CPU-keyed MAC, only checkable on the same machine). Contains measurements, SVNs, attributes, and 64 free bytes of report_data — the only channel to bind application data (TLS key hash, nonce) into attestation.
Quote: a report countersigned by the QE (Quoting Enclave) with an ECDSA P-256 attestation key, verifiable remotely. The PCE (Provisioning Certification Enclave) certifies the QE's key under the platform's PCK certificate, which chains to the Intel SGX Root CA.
Why DCAP replaced EPID: EPID required calling Intel's online IAS for every verification. DCAP verification uses cacheable X.509/JSON collateral, so it works offline, on-prem, and at scale. EPID is fully dead: IAS EOL 2025-04-02 (source, as of 2026-06-11), EPID code removed from PSW 2.28+ (source, as of 2026-06-11).
Limit of attestation: it proves code identity ("a genuine enclave running measurement X"), NOT instance identity or the trustworthiness of external dependencies — an attacker can run the same correct code against their own backing store and pass attestation. Documented in /home/steve-opacity/git/opacity-stack/README.md and /home/steve-opacity/git/opacity-stack/director/src/vdn.rs.
2. Ecosystem state (each row as of 2026-06-11)
Fact
Value
Source
Latest SGX SDK/PSW
2.29 (2026-04-30); Ubuntu 26.04, GCC 15
https://api.github.com/repos/intel/linux-sgx/releases/latest
Latest DCAP
1.26 (2026-04-30)
https://api.github.com/repos/intel/SGXDataCenterAttestationPrimitives/releases/latest
Repo rename
intel/linux-sgx → intel/confidential-computing.sgx (old URL redirects)
https://api.github.com/repos/intel/linux-sgx
Repo rename
intel/SGXDataCenterAttestationPrimitives → intel/confidential-computing.tee.dcap
https://api.github.com/repos/intel/SGXDataCenterAttestationPrimitives
PCCS location
Own repo intel/confidential-computing.tee.dcap.pccs since DCAP 1.24 (2025-12-22); still actively maintained
https://api.github.com/search/repositories?q=pccs+org%3Aintel
QVL location
Own repo intel/confidential-computing.tee.dcap.qvl (git submodule of DCAP)
https://raw.githubusercontent.com/intel/confidential-computing.tee.dcap.qvl/main/README.md
EPID/IAS
IAS EOL 2025-04-02; all EPID code removed from PSW 2.28+
https://community.intel.com/t5/Intel-Software-Guard-Extensions/IAS-End-of-Life-Announcement/td-p/1545831
PCS API
v4 only; v2/v3 EOL and unavailable
https://api.portal.trustedservices.intel.com/content/documentation.html
Client hardware
SGX deprecated on 11th/12th Gen Core, absent since; server Xeon only
https://en.wikipedia.org/wiki/Software_Guard_Extensions
DCAP hardware floor
FLC required (8th Gen Core or newer w/ FLC); upstream kernel driver supports only writable launch-control MSRs
https://www.kernel.org/doc/html/latest/arch/x86/sgx.html
Server SGX
Confirmed on 3rd Gen Xeon Scalable (Azure DCsv3, EPC up to 256 GB); 4th Gen (Sapphire Rapids), 5th Gen (Emerald Rapids), and Xeon 6 P-cores (Granite Rapids) named as SGX/TDX TCB-R 20 platforms in Intel's customer notice (received 2026-06-12; per-platform SGX-vs-TDX split not disambiguated there)
https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dcsv3-series
aesmd role
DCAP quote gen defaults to in-process (app loads QE3/PCE via libsgx_dcap_ql); set SGX_AESM_ADDR for out-of-process via aesmd (shared QE/PCE; some load-policy APIs return SGX_QL_UNSUPPORTED_MODE)
https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_SGX_ECDSA_QuoteLibReference_DCAP_API.pdf
QGS transport
Unix domain socket is the default in DCAP 1.26; vsock deployments must re-add port=<n> to qgs.conf (deb upgrades overwrite it)
https://github.com/intel/confidential-computing.tee.dcap/releases/tag/DCAP_1.26
Header move (DCAP 1.26)
sgx_qve_header.h removed from libsgx-dcap-quote-verify-dev; now in libsgx-headers >= 2.29 — build images need both packages
https://github.com/intel/confidential-computing.tee.dcap/releases/tag/DCAP_1.26
Intel apt repo
download.01.org/intel-sgx/sgx_repo/ubuntu still official; signing key intel-sgx-deb.key EXPIRES 2027-03-20
https://download.01.org/intel-sgx/sgx_repo/ubuntu/intel-sgx-deb.key
3. Quote formats: v3 vs v4 vs v5
Per the Intel TDX DCAP Quoting Library API, Appendix A (https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_TDX_DCAP_Quoting_Library_API.pdf, as of 2026-06-11):
v3: SGX-ECDSA only. The format both exemplar repos parse exclusively — and what their Gramine deployments emit in practice (Gramine's default emission version is otherwise UNVERIFIED).
v4: TD Quote Header + Body; covers TDX-ECDSA, SGX-ECDSA, SGX-EPID. Different layout — v3 offsets misread it.
v5: adds a TD Quote Body Descriptor with distinct body types for TDX 1.0/1.5 and SGX.
UNVERIFIED: which version current QGS/QE builds emit by default in production (findings gap; check before assuming v3 from non-Gramine generators).
Always read the u16 LE version at offset 0 and gate on it before touching any other offset. The offsets below are v3-only:
Abs offset
Size
Field
0
2
version (u16 LE; must be 3)
2
2
att_key_type (2 = ECDSA-P256; reject others)
8
2
QE SVN
10
2
PCE SVN
12
16
QE vendor ID (Intel = 939a7233-f79c-4ca9-940a-0db3957f0607)
28
20
user_data
48
384
report body (sgx_report_body)
112
32
MRENCLAVE (body offset 64)
176
32
MRSIGNER (body offset 128)
304
2
ISV prod ID (body offset 256)
306
2
ISV SVN (body offset 258)
368
64
report_data (convention in exemplars: [0..32] key binding, [32..64] nonce)
432
4
signature data length (u32 LE)
436
var
sig section: isv_signature[64], attest_pub_key[64], QE report[384], qe_report_signature[64], auth_data_size u16, auth_data, cert_key_type u16 (5 = PCK chain), cert_data (PEM)
Minimum valid v3 length: 432 bytes (48-byte header + 384-byte report body). Findings-verified anchors: version at 0, MRENCLAVE 112, MRSIGNER 176, report_data 368, min length 432; the header sub-offsets and ISV fields are sourced from the exemplar parsers /home/steve-opacity/git/sdk/ra-verify/src/types/quote.rs and .../types/report.rs (which mirror Intel's sgx_quote_3.h/sgx_report.h).
Parsing traps (from /home/steve-opacity/git/sdk/ra-verify/src/types/quote.rs):
attest_pub_key is a raw 64-byte P-256 X||Y point — prepend 0x04 before SEC1 parsing.
cert_data PEM chain is NUL-terminated — strip the trailing \0 or PEM parsing fails.
QE report binding: qe_report.report_data == SHA256(attest_pub_key || auth_data) || [0u8; 32] — verify both halves.
Worked v3 parsers: zerocopy structs in /home/steve-opacity/git/sdk/ra-verify/src/types/quote.rs; raw-offset reads in /home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs and /home/steve-opacity/git/sdk/ratls-freshness/src/lib.rs.
4. Collateral
What a verifier needs besides the quote (struct version 3 = sgx_ql_qve_collateral_t v3):
Piece
Form
Notes
PCK cert chain
PEM, embedded in quote tail (cert_key_type 5)
Leaf carries SGX extension OID 1.2.840.113741.1.13.1 (FMSPC, PCEID, TCB compsvns/pcesvn)
Root CA CRL
DER/PEM
PCS body is a hex string — decode first
PCK CRL + issuer chain
PEM
?ca=processor or ?ca=platform
TCB info + issuer chain
Signed JSON
Verify p256 signature over the RAW tcbInfo JSON bytes — never re-serialize (serde reordering breaks signatures)
QE identity + issuer chain
Signed JSON
Same raw-bytes rule for enclaveIdentity
Sources, in order of indirection:
Intel PCS v4 (live): GET https://api.trustedservices.intel.com/sgx/certification/v4/{tcb?fmspc=<hex>, qe/identity, pckcrl?ca=processor&encoding=der, rootcacrl}. Issuer chains arrive URL-encoded in response headers (TCB-Info-Issuer-Chain, SGX-Enclave-Identity-Issuer-Chain, SGX-PCK-CRL-Issuer-Chain) — urldecode and trim each line. Worked fetcher: /home/steve-opacity/git/sdk/sdk/src/flows/functions/generate_proof_utils/collateral_provider.rs.
PCCS: self-hostable caching proxy mirroring the v4 API shape (config example: /home/steve-opacity/git/opacity-stack/sgx_default_qcnl.conf).
QPL/QCNL (verifier side, Intel-QVL path only): libsgx-dcap-default-qpl reads /etc/sgx_default_qcnl.conf and fetches from PCCS automatically when you pass None collateral to tee_verify_quote. Needs a writable /var/cache or it silently re-fetches on every call (Gramine: mount tmpfs — see sgx-gramine).
Quick live checks (the exemplar fetcher succeeds with a placeholder subscription key, suggesting these GETs need no auth — UNVERIFIED, confirm against the PCS docs):
curl -s "https://api.trustedservices.intel.com/sgx/certification/v4/tcb?fmspc=00a067110000" | head -c 400   # TCB info (FMSPC from PCK leaf ext)curl -s "https://api.trustedservices.intel.com/sgx/certification/v4/qe/identity" | head -c 400curl -s "https://api.trustedservices.intel.com/sgx/certification/v4/tcbevaluationdatanumbers"
TCB evaluation data numbers (https://api.trustedservices.intel.com/sgx/certification/v4/tcbevaluationdatanumbers, as of 2026-06-11): 13–21 live; 21 corresponds to the 2026-02-10 TCB recovery event. TCB info requests take update=early|standard (early = day of disclosure, standard = ~12 months later) OR tcbEvaluationDataNumber=<n> to pin a historical evaluation (410 Gone if too old, 404 if not yet) — the two parameters cannot be combined (https://api.portal.trustedservices.intel.com/content/documentation.html, as of 2026-06-11).
Scheduled standard-track switch: on 2026-08-12 (~11pm PT) the PCS TCB-info/identity endpoints switch update=standard (and the no-value default) to TCB-R 20 collateral — TCB-R 20 being the 2025-08-12 recovery event (live endpoint, fetched 2026-06-12). Early track already serves 21. Platforms without TCB-R 20 mitigations (Intel names 4th/5th Gen Xeon Scalable and Xeon 6 P-cores as affected) start failing default-collateral verification from that date. Source: Intel Confidential Computing Team customer email, received 2026-06-12; details on Intel's TCB-R guidance page (intel.com, 403s direct fetch). Intel announces these completion dates by customer email — record each one here.
collateral_expiration_status (QVL out-param): non-zero means some collateral piece is expired relative to the caller-supplied expiration check date. The opacity-stack exemplar treats non-zero as a hard failure even when the quote result is OK (/home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs) (https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_SGX_ECDSA_QuoteLibReference_DCAP_API.pdf, as of 2026-06-11).
5. TCB status policy
QVL results per the Intel SGX ECDSA QuoteLibReference DCAP API (https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_SGX_ECDSA_QuoteLibReference_DCAP_API.pdf, as of 2026-06-11):
Status
Meaning
Sane production handling
OK / UpToDate
Platform TCB current, no advisories
Accept
SW_HARDENING_NEEDED
Hardware TCB fine, but enclave code must carry software mitigations for listed advisories
Accept only against an explicit advisory-ID allowlist, after confirming the enclave build has those mitigations
CONFIG_NEEDED
Platform needs a BIOS/config change
Accept only with a documented config-risk assessment
CONFIG_AND_SW_HARDENING_NEEDED
Both of the above
Combine both rules; most restrictive wins
OUT_OF_DATE / OUT_OF_DATE_CONFIG_NEEDED
Platform TCB below current evaluation
Reject; at most a time-boxed exception during a TCB recovery rollout
REVOKED
TCB level revoked by Intel
Hard reject, always
Policy rules: maintain an explicit allowlist of accepted statuses AND advisory IDs; log every non-OK acceptance; never silently map non-OK to OK; re-evaluate the allowlist after each TCB recovery (latest: Feb 2026, eval number 21).
Worked examples:
/home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs: accepts CONFIG_NEEDED / SW_HARDENING_NEEDED / CONFIG_AND_SW_HARDENING_NEEDED with a log (documented plan: reject in production on advisory-free hardware); collateral_expiration_status != 0 is a hard failure; everything else rejected.
/home/steve-opacity/git/sdk/ra-verify/src/lib.rs: accepts SWHardeningNeeded and returns advisory_ids for the caller to assess; temporarily maps ConfigurationAndSWHardeningNeeded to SWHardeningNeeded with EMPTY advisory IDs — a documented compromise that silently drops advisories; don't copy without that caveat.
Note rejecting everything but OK bricks real dev/staging clusters — most live hardware carries some advisory. The policy must be a deliberate decision, not a default.
6. Choosing a verification stack
Intel QVL/QvE path — intel-tee-quote-verification-rs → libsgx-dcap-quote-verify → QPL/QCNL → PCCS:
tee_verify_quote(&quote, None, current_time, None, None) — None collateral makes the QVL fetch via QPL; passing None for the QvE report params selects untrusted host-side verification, as used in the exemplar (UNVERIFIED against the API doc).
Crate status (as of 2026-06-11): 0.3.0 is the latest crates.io release (2023-10-24) and is dormant — in-tree DCAP source advanced through 1.23 without a publish. Matter Labs' fork teepot-tee-quote-verification-rs (0.6.0, 2025-06-25, github.com/matter-labs/teepot) is the de facto successor for newer QVL coverage (https://crates.io/crates/intel-tee-quote-verification-rs).
Build needs Intel headers + libclang for bindgen even for cargo check (DCAP 1.26: also libsgx-headers >= 2.29). Hermetic check image pattern: /home/steve-opacity/git/opacity-stack/Dockerfile.sgx-check.
Choose when: server-side Linux x86_64, PCCS infrastructure exists, you want Intel's reference appraisal logic.
Exemplar: /home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs.
Pure-Rust QvE-less path — libsignal-derived ra-verify pattern:
RustCrypto only (p256 0.13.2, x509-cert 0.2.5, x509-verify 0.4.8, asn1, zerocopy — all current stable pins as of 2026-06-11 per crates.io); zero Intel C libraries, so it cross-compiles to iOS/Android.
Trust root: pin the Intel SGX Root CA public key (not the cert) + the Intel QE vendor UUID; everything else derives from chain verification.
Pipeline: chain/CRL integrity → TCB info + QE identity signed-JSON verification → QE report binding → quote signature → TCB level matching (all 16 compsvns + pcesvn >= level) → MRENCLAVE equality.
App must fetch collateral itself (PCS v4-shaped service) and inject verification time — SystemTime::now() is host-controlled inside TEEs.
Choose when: client/mobile verifiers, no PCCS, no Intel apt packages, or any non-x86 target.
Exemplar: /home/steve-opacity/git/sdk/ra-verify/src/lib.rs (known footguns: TCB-info signature check panics instead of erroring in types/tcb_info.rs; CRL matching is by bare serial, unscoped to issuer).
7. scripts/inspect_quote.py
Stdlib-only quote field dumper (v3 layout, version-gated):
python3 ~/.claude/skills/sgx-attestation/scripts/inspect_quote.py quote.binpython3 ~/.claude/skills/sgx-attestation/scripts/inspect_quote.py --hex 0x0300...      # e.g. from an x-response-quote headerpython3 ~/.claude/skills/sgx-attestation/scripts/inspect_quote.py --b64 AwACAA...python3 ~/.claude/skills/sgx-attestation/scripts/inspect_quote.py --force quote_v4.bin  # dump v3-offset fields anyway (garbage on v4/v5)
Prints version, att_key_type, QE/PCE SVNs, QE vendor ID, MRENCLAVE, MRSIGNER, ISV prod ID/SVN, report_data split [0..32]/[32..64], declared vs actual signature-section length, and whether a PEM PCK chain is embedded. Exits 1 on non-v3 quotes unless --force. Grab a live quote from a Gramine enclave via /dev/attestation/quote or an /attestation-quote debug endpoint (a 0x prefix is accepted as-is with --hex).
2. Gramine (SGX LibOS)
Skill: sgx-gramine — Gramine LibOS knowledge for SGX work.
Gramine (SGX LibOS)
Staleness check (do this first): Facts below were verified against live Intel/Gramine sources on 2026-06-11. The SGX ecosystem moves fast and Intel renames/relocates repos. Before relying on any version number, URL, API shape, or deprecation status for a real decision, re-verify it online (WebSearch/WebFetch). Prefer official sources: github.com/intel/confidential-computing.sgx (ex linux-sgx), github.com/intel/confidential-computing.tee.dcap (ex SGXDataCenterAttestationPrimitives), download.01.org, api.portal.trustedservices.intel.com, gramine.readthedocs.io. Treat any dated claim older than ~6 months as suspect until re-checked.
Siblings: sgx-attestation (DCAP concepts, quote byte offsets, collateral, PCS/PCCS, inspect_quote.py), sgx-ratls (quote-in-cert design, custom rustls verifiers, EKM freshness), sgx-troubleshooting (symptom checklists, check-sgx-env.sh).
1. State of Gramine
Fact
Value
Source (as-of 2026-06-11)
Latest release
v1.9, published 2025-06-20 (no v1.10/v2.0 exists)
https://github.com/gramineproject/gramine/releases/tag/v1.9
Master branch
No commits since 2025-06-20; PR triage through 2026-03-30; key maintainer went part-time. Maintenance-slowdown signal — UNVERIFIED whether formal (no official status statement found)
https://api.github.com/repos/gramineproject/gramine/commits?sha=master&per_page=5
Docker tag
gramineproject/gramine:stable-jammy is a floating tag, currently resolves to v1.9 (rebuilds silently jumped v1.8→v1.9). Pin 1.9-jammy for reproducible MRENCLAVE
https://github.com/gramineproject/gramine/releases
Release cadence
v1.4 2023-02-13, v1.5 2023-07-07, v1.6 2023-12-14, v1.6.2 2024-03-12 (security fix), v1.7 2024-04-24, v1.8 2024-10-21, v1.9 2025-06-20
https://api.github.com/repos/gramineproject/gramine/releases?per_page=15
v1.9 notables
EPID attestation REMOVED (DCAP-only), OOT driver/non-FLC dropped, encrypted-files format v2 (v1.8-sealed files need migration), mbedTLS 3.6.3, min Meson 0.58
https://github.com/gramineproject/gramine/releases/tag/v1.9
2. Toolchain workflow
# 0. One-time signing key: RSA-3072, public exponent 3 (SGX requirement)gramine-sgx-gen-private-key            # -> ~/.config/gramine/enclave-key.pem ($XDG_CONFIG_HOME/gramine/)# 1. Jinja2 template -> manifest (built-in JSON-schema check; hard-error since v1.8; --no-check to skip)gramine-manifest -Dservice=node -Darch_libdir=/lib/x86_64-linux-gnu app.manifest.template app.manifest# 2. Sign: expands trusted-file hashes into .manifest.sgx, writes SIGSTRUCT to app.siggramine-sgx-sign --manifest app.manifest --key ~/.config/gramine/enclave-key.pem --output app.manifest.sgx#   --date YYYY-MM-DD for reproducible builds; --with <backend> for pluggable signing (default 'file')# 3. Rungramine-sgx app          # under SGXgramine-direct app       # no SGX (LibOS only, for debugging)# Read MRENCLAVE from the .sig (canonical measurement source)gramine-sgx-sigstruct-view app.sig | awk '/mr_enclave/{print $2}'# Inspect a quote (was gramine-sgx-quote-dump before v1.5)gramine-sgx-quote-view quote.bin
Sources: https://gramine.readthedocs.io/en/stable/manpages/gramine-sgx-sign.html , https://gramine.readthedocs.io/en/stable/manpages/gramine-sgx-gen-private-key.html (Gramine v1.9). Jinja template functions available in templates: gramine.runtimedir(libc='glibc'|'musl'), gramine.libos, ldd(...), env.[VAR], python.*.
3. Manifest essentials (v1.9 syntax)
Source: https://gramine.readthedocs.io/en/stable/manifest-syntax.html (Gramine v1.9, fetched 2026-06-11).
Key
Semantics
libos.entrypoint
Absolute in-Gramine path (URI form REMOVED in v1.9). loader.entrypoint optional since v1.8
sgx.enclave_size
Default "256M" without EDMM; with EDMM it is a growth cap (max "1024G")
sgx.max_threads
Default 4. With EDMM: pre-allocated slots, threads may exceed it (since v1.6). Pending rename per master docs
sgx.trusted_files
String URIs or {uri=..., sha256=...} tables; hashed at sign time, read-only at runtime. Typically: entrypoint, gramine.runtimedir(), lib dirs — plus CA bundle and /etc/sgx_default_qcnl.conf if the enclave does outbound TLS / DCAP verification
sgx.allowed_files
file:/dev: URIs, unconditional R/W, NOT integrity-protected — host-controlled attack surface
sgx.remote_attestation
"none" (default) or "dcap". "epid" REMOVED in v1.9
loader.env.X
= "value", or = { value = "..." }, or = { passthrough = true } (host inheritance). value/passthrough cannot mix for one var. loader.env_src_file = "file:..." for serialized envs (loader.env wins)
sgx.edmm_enable
Default false (opt-in, both stable and master). When true: on-demand allocation (faster startup, lower EPC), enclave_size becomes a cap, dynamic threads beyond max_threads, MAP_NORESERVE lazy alloc since v1.8. Needs EDMM-capable CPU (min CPU/kernel reqs UNVERIFIED)
fs.mounts
Array of tables; types: chroot (default), encrypted (format v2 in v1.9, file recovery support), tmpfs, untrusted_shm
sys.stack.size
Default "256K" — bump for real workloads (opacity-stack uses "8M" after crashes)
sys.fds.limit
Default 900 (RLIMIT_NOFILE)
sys.enable_sigterm_injection
Default false; host can inject SIGTERM at arbitrary time under SGX
Exemplar: one shared parameterized manifest for 6 services — /home/steve-opacity/git/opacity-stack/manifest.template (Jinja conditionals on -Dservice=).
Field-proven manifest settings (from /home/steve-opacity/git/opacity-stack/manifest.template):
loader.env.MALLOC_ARENA_MAX = "1" — glibc per-thread arenas balloon committed memory inside fixed enclave_size; removing it in favor of bigger enclave was tried and reverted.
loader.env.SSL_CERT_FILE pinned to the single ca-certificates.crt bundle (also in trusted_files) — scanning hashed certs under /etc/ssl/certs is slow under Gramine's FS shim.
tmpfs mounts for /tmp and /var/cache — without writable /var/cache, the DCAP QPL silently re-fetches PCCS collateral on every verification (no error, just latency).
sys.enable_extra_runtime_domain_names_conf = true for runtime DNS.
loader.env.SGX = "1" so app code can detect SGX; no TTY exists, so force color (CLICOLOR_FORCE=1) — isatty detection fails.
4. Deprecations and renames (old-manifest troubleshooting table)
Old
Status / replacement
Source
sgx.thread_num
RENAMED to sgx.max_threads in v1.4; old name REMOVED in v1.5
https://api.github.com/repos/gramineproject/gramine/releases/tags/v1.5
loader.debug_type
REMOVED v1.5 → loader.log_level / loader.log_file
same v1.5 source
fs.mount.[id].type/path/uri (table form)
REMOVED v1.5 → fs.mounts = [...] array
same
`sgx.remote_attestation = true\
false` (boolean)
REMOVED v1.5 → string `"none"\
"dcap"`
same
sgx.protected_files / protected_mrenclave_files / protected_mrsigner_files
REMOVED v1.5 → fs.mounts with type = "encrypted"
same
sgx.insecure__protected_files_key
REMOVED v1.5 → fs.insecure__keys.[NAME]
same
loader.pal_internal_mem_size, fs.experimental__enable_sysfs_topology, sgx.nonpie_binary
REMOVED v1.5 (no longer needed)
same
gramine-sgx-quote-dump tool
RENAMED to gramine-sgx-quote-view in v1.5
same
RA_TLS_ALLOW_OUTDATED_TCB_INSECURE (catch-all)
SPLIT in v1.5 into RA_TLS_ALLOW_OUTDATED_TCB_INSECURE + RA_TLS_ALLOW_HW_CONFIG_NEEDED + RA_TLS_ALLOW_SW_HARDENING_NEEDED
same
sgx.require_avx / sgx.require_[...]
REMOVED v1.8 (2024-10-21) → `sgx.cpu_features.[...] = "unspecified"\
"disabled"\
"required"`
https://api.github.com/repos/gramineproject/gramine/releases/tags/v1.8
Implicit RA-TLS measurement defaults
BREAKING v1.8: RA_TLS_MRSIGNER/MRENCLAVE/ISV_PROD_ID/ISV_SVN MUST be set explicitly; value "any" skips a check
same v1.8 source
sgx.remote_attestation = "epid", OOT driver, non-FLC HW, gramine-ratls-epid, ra_tls_verify_epid
REMOVED v1.9 (2025-06-20) — only `"none"\
"dcap"` remain
https://github.com/gramineproject/gramine/releases/tag/v1.9
libos.entrypoint URI form
REMOVED v1.9 — plain absolute path only
same v1.9 source
SECRET_PROVISION_SET_PF_KEY
REMOVED v1.9 → SECRET_PROVISION_SET_KEY
same
sgx.max_threads (name itself)
PENDING rename per master docs ("after non-EDMM platform support is dropped") — not yet shipped
https://gramine.readthedocs.io/en/latest/manifest-syntax.html
sgx.insecure__allow_memfaults_without_exinfo
DEPRECATED on master, "will be removed in near future"
same master docs
Legacy non-standard RA-TLS cert OID
DEPRECATED: kept alongside Interoperable RA-TLS (TCG DICE tagged evidence, CBOR) since v1.8; planned removal
https://gramine.readthedocs.io/en/stable/attestation.html
sys.experimental__enable_flock
EXPERIMENTAL; to become default in a future release
master docs
5. RA-TLS libraries and /dev/attestation
Source: https://gramine.readthedocs.io/en/stable/attestation.html (Gramine v1.9).
Attest side — ra_tls_attest.so / libra_tls_attest (requires manifest sgx.remote_attestation = "dcap"):
// build.rs: println!("cargo:rustc-link-lib=ra_tls_attest");  // lives in /usr/lib/x86_64-linux-gnu in the Gramine imageunsafe extern "C" {    fn ra_tls_create_key_and_crt_der(der_key: *mut *mut u8, der_key_size: *mut usize,                                     der_crt: *mut *mut u8, der_crt_size: *mut usize) -> c_int;}
Returned buffers are C-allocated: copy, then libc::free() both.
Key may come back as PKCS#8/SEC1 DER or PEM — try DER first, fall back on ----- prefix.
Detect "am I under Gramine?" by checking /dev/attestation exists before calling.
Env knobs: RA_TLS_CERT_TIMESTAMP_NOT_BEFORE / RA_TLS_CERT_TIMESTAMP_NOT_AFTER.
Since v1.8 certs carry BOTH the TCG DICE tagged-evidence OID (CBOR) and the legacy Gramine OID; legacy OID slated for removal — see sgx-ratls for OID values and verifier-side parsing quirks.
Exemplars: /home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs + build.rs; /home/steve-opacity/git/sdk/tee-proxy-tls/src/ra_tls.rs.
Verify side — ra_tls_verify_dcap.so env knobs: RA_TLS_MRENCLAVE, RA_TLS_MRSIGNER, RA_TLS_ISV_PROD_ID, RA_TLS_ISV_SVN (mandatory since v1.8; "any" skips a measurement check); optional insecure overrides RA_TLS_ALLOW_DEBUG_ENCLAVE_INSECURE, RA_TLS_ALLOW_OUTDATED_TCB_INSECURE, RA_TLS_ALLOW_HW_CONFIG_NEEDED, RA_TLS_ALLOW_SW_HARDENING_NEEDED (default off; set "0" for prod). A standalone gramine-ratls CLI exists since v1.5. EPID verify libs are gone (v1.9).
Secret provisioning: secret_prov_attest.so (enclave side; SECRET_PROVISION_CONSTRUCTOR/SET_KEY/SERVERS/CA_CHAIN_PATH; secret_provision_get()) and secret_prov_verify_dcap.so (untrusted server side).
/dev/attestation pseudo-fs quote protocol:
write exactly 64 bytes -> /dev/attestation/user_report_dataread                   <- /dev/attestation/quote
Two hard-won gotchas:
The write+read pair is NOT atomic — concurrent generators interleave and get quotes with someone else's report_data. Hold a process-global Mutex around the pair. Hit in both repos (/home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs, /home/steve-opacity/git/sdk/tee-proxy-tls/src/freshness.rs)
Quote generation is blocking I/O (Gramine talks to AESM underneath) — on tokio, wrap in tokio::task::spawn_blocking; doing it inline on the runtime caused real problems. Documented in opacity-stack (ratls/src/client.rs, server/middleware.rs).
Runtime prerequisites in containers: devices /dev/sgx_enclave + /dev/sgx_provision, AESM socket mounted at /var/run/aesmd/aesm.socket, and /etc/sgx_default_qcnl.conf (in trusted_files) for DCAP collateral.
6. Reproducible MRENCLAVE
MRENCLAVE covers the binary AND the signed manifest. Any manifest change — an env var value, a trusted file, enclave_size, anything — shifts the measurement. Consequences and patterns:
Don't bake variable config into the manifest. Inject it via loader.env.X = { passthrough = true } so prod/staging/sandbox share one MRENCLAVE. Trade-off: every passthrough var is host-controlled and becomes attack surface — document it (opacity-stack /home/steve-opacity/git/opacity-stack/README.md security table). Counter-example: sdk templates OPACITY_ENV into the manifest, so each environment gets a different MRENCLAVE for identical binaries (/home/steve-opacity/git/sdk/tee-proxy-tls/README.sgx.md).
Measure at build time, distribute out of band. gramine-sgx-sigstruct-view <name>.sig after signing; never trust a value the attested party reports about itself.
Two-pass CI for mutually-attesting enclaves (exemplar: /home/steve-opacity/git/opacity-stack/.github/workflows/docker-image-build.yaml): pass 1 builds+signs all images and records each MRENCLAVE; pass 2 bakes each peer's measurement into final image layers as host-readable plain files, read by the startup script and exported as env vars before exec gramine-sgx. They cannot go inside the measured manifest — circular measurement.
Pin everything that feeds the build: Gramine image version tag (1.9-jammy, not floating stable-jammy), base images, gramine-sgx-sign --date YYYY-MM-DD.
Signing key continuity: running gramine-sgx-gen-private-key inside each docker build gives a fresh MRSIGNER per build — fine for MRENCLAVE-pinned trust, but SGX sealing keys derive from MRSIGNER, so sealed data will not survive rebuilds. Use a stable key if you seal.
7. Dev ergonomics without SGX hardware
Cargo feature-gate all SGX code (feature = "sgx"): FFI, quote-verification deps, rustls RA-TLS config behind the gate; pure types/byte helpers stay available so non-SGX builds link and the test suite runs on laptops (plain-HTTP fallback). Exemplars: /home/steve-opacity/git/opacity-stack/ratls/Cargo.toml + src/lib.rs; /home/steve-opacity/git/sdk/sdk/Cargo.toml.
Type-check the gated code hermetically: a slim docker image (Ubuntu jammy + Intel SGX apt repo + libsgx-dcap-quote-verify-dev headers only — no runtime libs, no SGX device) runs cargo check --features sgx. bindgen needs the DCAP header (sgx_dcap_quoteverify.h) and a sane LIBCLANG_PATH. Exemplars: /home/steve-opacity/git/opacity-stack/Dockerfile.sgx-check (mise check-sgx), /home/steve-opacity/git/sdk/Dockerfile.sgx-check + scripts/check-sgx.mts. Note (as-of 2026-06-11): DCAP 1.26 (2026-04-30) moved sgx_qve_header.h out of libsgx-dcap-quote-verify-dev into libsgx-headers >= 2.29 — images including that header must also install libsgx-headers (https://github.com/intel/confidential-computing.tee.dcap/releases/tag/DCAP_1.26).
One parameterized manifest for many services: Jinja conditionals + gramine-manifest -Dservice=<name> -Dentrypoint=... -Darch_libdir=... -Dapp_dir=... beats N drifting manifest copies (/home/steve-opacity/git/opacity-stack/manifest.template).
Run test suites inside an enclave when tests must attest: build with cargo test --no-run, make the test binary the manifest entrypoint with loader.argv carrying --test-threads=1 --nocapture (/home/steve-opacity/git/opacity-stack/e2e-tests/cargo-test.manifest.template).
SGX host autodetect gate for scripts: /dev/sgx_enclave and /dev/sgx_provision exist and /etc/sgx_default_qcnl.conf present.
Cleanup: killed gramine-sgx processes leave orphaned loader ... child N processes (ppid 1, comm loader); test harnesses must hunt and kill them (/home/steve-opacity/git/opacity-stack/scripts/test-common.sh).
8. Ecosystem context (one-liners, as-of 2026-06-11)
Gramine = C LibOS, unmodified multi-process Linux binaries, one enclave per process. Occlum = Rust LibOS multiplexing lightweight processes in one enclave (own toolchain; 2026 activity UNVERIFIED). SCONE = commercial thin libc shielding layer (characterization from Intel CC-Zoo, not vendor-verified). EGo = Go-only SDK (v1.9.0 released 2026-03-13, https://github.com/edgelesssys/ego). gramine-tdx = experimental sibling repo for Intel TDX VMs (release-level details UNVERIFIED).
3. SGX RA-TLS: Attestation-Authenticated TLS
Skill: sgx-ratls — RA-TLS design patterns for SGX.
SGX RA-TLS: Attestation-Authenticated TLS
Staleness check (do this first): Facts below were verified against live Intel/Gramine sources on 2026-06-11. The SGX ecosystem moves fast and Intel renames/relocates repos. Before relying on any version number, URL, API shape, or deprecation status for a real decision, re-verify it online (WebSearch/WebFetch). Prefer official sources: github.com/intel/confidential-computing.sgx (ex linux-sgx), github.com/intel/confidential-computing.tee.dcap (ex SGXDataCenterAttestationPrimitives), download.01.org, api.portal.trustedservices.intel.com, gramine.readthedocs.io. Treat any dated claim older than ~6 months as suspect until re-checked.
Sibling skills — link, don't duplicate: sgx-attestation (DCAP quote byte layouts/offsets, collateral, TCB policy, PCS/PCCS; has scripts/inspect_quote.py), sgx-gramine (manifest syntax, signing toolchain, RA-TLS env knobs, reproducible MRENCLAVE), sgx-troubleshooting (symptom→cause checklists; has scripts/check-sgx-env.sh).
Exemplar repos cited throughout:
/home/steve-opacity/git/opacity-stack — Pattern A: SGX↔SGX mutual RA-TLS (rust workspace, ratls/ crate)
/home/steve-opacity/git/sdk — Pattern B: SGX server ↔ non-SGX mobile client (ra-verify, ratls-freshness, tee-proxy-tls crates)
1. Core idea
Replace web PKI with attestation:
Inside the enclave, generate a key pair and a self-signed X.509 cert (Gramine: FFI to ra_tls_create_key_and_crt_der in libra_tls_attest).
Embed an SGX DCAP quote in an X.509 extension of that cert.
The quote's report_data[0..32] = SHA-256 of the cert's SubjectPublicKeyInfo — this binds the quote to the TLS key.
The verifier ignores PKI entirely (issuer, validity dates, server name) and instead: extracts the quote, runs DCAP verification, and checks report_data[0..32] == SHA256(SPKI).
The explicit key-binding check (step 4) is non-negotiable: a valid quote alone proves "some genuine enclave exists somewhere." Without the binding check, an attacker can pair a stolen valid quote with their own key and pass verification. The TLS handshake signature then proves possession of the bound key. See verify_attestation in /home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs (explicit comment + check).
Limits of what this proves: code identity (MRENCLAVE), not instance identity or the trustworthiness of the enclave's external dependencies. An attacker running the same correct enclave code against their own backing store passes attestation (documented attack in /home/steve-opacity/git/opacity-stack/README.md and director/src/vdn.rs).
2. The Gramine quote extension OID
Fact
Value
Source / as-of
Legacy Gramine RA-TLS quote OID
0.6.9.42.840.113741.1337.6
both exemplar repos; gramine.readthedocs.io/en/stable/attestation.html (as of 2026-06-11)
Interoperable RA-TLS OID (TCG DICE tagged evidence, CBOR)
2.23.133.5.4.9 — embedded alongside legacy OID since Gramine v1.8
https://gramine.readthedocs.io/en/stable/attestation.html (as of 2026-06-11)
Legacy OID status
DEPRECATED, planned removal in a future Gramine release — verifiers parsing only the legacy OID will break
https://gramine.readthedocs.io/en/stable/attestation.html (as of 2026-06-11)
Double-encoding gotcha: in Gramine-generated certs as seen through x509-parser, the extension OID matches Oid::from(&[0, 6, 9, 42, 840, 113741, 1337, 6]) — the component encoding of that array equals the full DER TLV (tag+len+value) of 1.2.840.113741.1337.6. Naive matching against 1.2.840.113741.1337.6 fails. Reproduce the quirk or strip the inner TLV. Seen in /home/steve-opacity/git/sdk/sdk/src/flows/functions/generate_proof_utils/ra_tls_verifier.rs. UNVERIFIED whether this is a Gramine cert-encoding artifact or an x509-parser Oid::from semantic — check Gramine's ra_tls.h before relying on the explanation (the byte-match itself is verified working code).
Extraction sketch (x509-parser):
let (_, cert) = X509Certificate::from_der(cert_der)?;let quote_oid = Oid::from(&[0, 6, 9, 42, 840, 113741, 1337, 6]).unwrap(); // note double-encodinglet quote = cert.extensions().iter()    .find(|e| e.oid == quote_oid)    .map(|e| e.value)    .ok_or(Error::NoQuoteExtension)?;// key binding check — never skip:let spki = cert.public_key().raw;ensure!(quote[368..400] == Sha256::digest(spki)[..], "quote not bound to TLS key");
Quote byte offsets (MRENCLAVE@112, MRSIGNER@176, report_data@368, v3 vs v4/v5 formats): see sgx-attestation. The one offset fact this skill needs: report_data is 64 bytes; [0..32] = key binding, [32..64] = freshness nonce (section 5).
3. Pattern A — SGX↔SGX mutual RA-TLS (opacity-stack)
Both directions need a custom verifier:
// client: verify the server's attested cert, present our own attested certClientConfig::builder().dangerous()    .with_custom_certificate_verifier(Arc::new(RaTlsServerCertVerifier::new(...)))    .with_client_auth_cert(enclave_certs, enclave_key)?;// server: demand and verify the client's attested certServerConfig::builder()    .with_client_cert_verifier(Arc::new(RaTlsClientCertVerifier::new(...)))    .with_single_cert(enclave_certs, enclave_key)?;
Files: /home/steve-opacity/git/opacity-stack/ratls/src/client/verifier.rs, server/verifier.rs.
What a custom verifier MUST still do (skipping any of these is a real vulnerability or interop break):
Delegate verify_tls12_signature / verify_tls13_signature to the real crypto provider (rustls::crypto::verify_tls13_signature with the provider's WebPkiSupportedAlgorithms, or per-scheme aws-lc-rs UnparsedPublicKey). Returning assertion() unconditionally lets a MITM present the attested cert without the key.
ClientCertVerifier must return empty root_hint_subjects (no CA hints to send).
Deliberately ignore server_name, intermediates, OCSP, and the now validity check — attestation replaces all of them; cert dates on RA-TLS certs are meaningless.
Performance: cache verification results keyed on exact cert DER (RwLock<HashSet<Vec<u8>>>, or hash of DER with TTL) so the expensive DCAP+collateral verification runs once per unique cert per process. Cache staleness is acceptable only because per-request EKM quotes (section 5) provide freshness.
MRENCLAVE allowlist management (multi-enclave systems):
Never compile measurements in. Measure post-build: gramine-sgx-sigstruct-view name.sig | awk '/mr_enclave/{print $2}', inject via env vars (OPACITY_*_MR_ENCLAVE), hard-fail at startup if missing; in production also enforce 64-char hex (empty value silently weakens pinning). See /home/steve-opacity/git/opacity-stack/shared/src/ratls.rs.
Mutual pinning is circular (A's measurement can't be baked into B's measured manifest and vice versa) → two-pass CI build: pass 1 builds+signs all enclaves and records each MRENCLAVE; pass 2 bakes peer measurements into final image layers as host-readable files, exported as env vars by the host startup script before exec gramine-sgx. See /home/steve-opacity/git/opacity-stack/.github/workflows/docker-image-build.yaml.
4. Pattern B — SGX server → non-SGX client (sdk, mobile)
iOS/Android can't link Intel's QVL/QvE, so verification must be pure Rust (QvE-less):
ra-verify crate (/home/steve-opacity/git/sdk/ra-verify/, adapted from signalapp/libsignal) reimplements the DCAP appraisal pipeline with RustCrypto only (p256, x509-cert, x509-verify, asn1, zerocopy): chain/CRL verification → quote+QE-report signature checks → TCB-level matching → MRENCLAVE equality. Details of the pipeline and collateral structures: sgx-attestation.
Trust root: pin the Intel SGX Root CA public key (SPKI), not the cert — verify the collateral's root is self-issued AND signed by the pinned key, then seed a trust store. Pin the QE vendor UUID 939a7233-f79c-4ca9-940a-0db3957f0607 too. See /home/steve-opacity/git/sdk/ra-verify/src/types/mod.rs.
Collateral comes from a PCS-v4-shaped service (/sgx/certification/v4/tcb?fmspc=…, /v4/qe/identity, /v4/pckcrl, /v4/rootcacrl); issuer chains arrive URL-encoded in response headers. PCS v4 is the only live Intel API version — v2/v3 reached EOL (https://api.portal.trustedservices.intel.com/content/documentation.html, as of 2026-06-11).
Client side is one-way: ClientConfig::builder().dangerous().with_custom_certificate_verifier(...).with_no_client_auth() — the mobile device has nothing to attest.
Packaging: the sdk crate builds as cdylib/rlib → iOS xcframework (aarch64-apple-ios, plus aarch64-apple-ios-sim and x86_64-apple-ios sim slices combined with lipo) and Android .so; the only C dep on the client TLS path is aws-lc-rs built with feature bindgen for cross-compilation. See /home/steve-opacity/git/sdk/scripts/build.ios.mts.
5. Freshness: EKM-bound per-request quotes
Cert-level quotes are not fresh — Gramine generates the quote once at startup, and verifiers cache cert verification. Replay protection must be explicit. The pattern (both repos):
Both peers independently derive the same 32-byte nonce from the live TLS session — RFC 5705 exporter keying material. The label below is the exemplars' application-specific choice; pick your own unique label, but both peers must use the identical one:
let mut ekm = [0u8; 32];conn.export_keying_material(&mut ekm, b"EXPORTER-opacity-vdn-attestation-v1", None)?;
Fresh quote generation under Gramine (pseudo-filesystem; serialize + offload, see pitfalls):
static QUOTE_GEN_LOCK: Mutex<()> = Mutex::new(());fn generate_quote(report_data: &[u8; 64]) -> io::Result<Vec<u8>> {    let _g = QUOTE_GEN_LOCK.lock().unwrap();          // write+read is NOT atomic    fs::write("/dev/attestation/user_report_data", report_data)?;    fs::read("/dev/attestation/quote")                // call via spawn_blocking on tokio}// runtime "am I in SGX?" probe: Path::new("/dev/attestation").exists()
Requester puts a fresh quote with report_data[32..64] = EKM in an x-request-quote header; responder verifies it (full DCAP + nonce match + MRENCLAVE), then attaches its own EKM-bound quote as x-response-quote; requester verifies that against the same EKM. ([0..32] stays the cert-key binding hash.)
Properties: bound to the live channel (a replayed quote has the wrong EKM), bidirectional, zero extra round trips — no challenge/response protocol.
Both sides must use the identical label and context = None or EKMs won't match.
A missing response quote is always an error, even on non-2xx responses (tests pin this in opacity-stack).
Why this forces hand-rolled HTTP plumbing: export_keying_material lives on the rustls Connection object. reqwest and axum::serve never expose it.
Server: manual accept loop — TcpListener → tokio_rustls::TlsAcceptor → after handshake, export EKM and inject it into request extensions (req.extensions_mut().insert(Ekm(...))) → hyper_util auto server with service_fn wrapping router.oneshot(req). The freshness check itself is an axum route_layer middleware reading the injected EKM. See /home/steve-opacity/git/opacity-stack/ratls/src/server.rs, server/middleware.rs. (sdk variant: wrap axum_server's RustlsAcceptor in a custom Accept impl — /home/steve-opacity/git/sdk/tee-proxy-tls/src/freshness.rs.)
Client: TcpStream → tokio_rustls TlsConnector → export EKM → hyper::client::conn::http1 handshake, with explicit timeouts at every stage and a body cap (http_body_util::Limited). See /home/steve-opacity/git/opacity-stack/ratls/src/client.rs, /home/steve-opacity/git/sdk/sdk/src/flows/functions/generate_proof_utils/notary_https_client.rs (also: never retry after bytes hit the wire on non-idempotent calls; pool per host:port remembering EKM + verified response quote, byte-compare on reuse).
UNVERIFIED edge: rustls TLS 1.3 exporter semantics under session resumption (resumption can change exporter secrets). Both exemplar repos sidestep it (fresh connection per request, or one quote per pooled connection). Re-verify before relying on EKM across resumed sessions.
6. Pitfalls
Pitfall
Fix
Where seen
PCK PEM chain inside the quote has a trailing NUL byte
strip_suffix(&[0]) before PEM parsing
/home/steve-opacity/git/sdk/ra-verify/src/types/quote.rs
Quote's attest_pub_key is raw 64-byte X‖Y
prepend 0x04 before p256 VerifyingKey::from_sec1_bytes
/home/steve-opacity/git/sdk/ra-verify/src/lib.rs
/dev/attestation write(user_report_data)+read(quote) races under concurrency → quote carries someone else's nonce
process-global Mutex around the pair; also it's blocking I/O — use tokio::task::spawn_blocking
both repos (attestation.rs, freshness.rs)
SystemTime::now() is host-controlled inside a TEE
take current_time as a verification parameter; inject a trusted source when the verifier runs in-enclave
/home/steve-opacity/git/sdk/ra-verify/src/lib.rs
Re-serializing signed collateral JSON (TCB info / QE identity) breaks signatures
keep Box<RawValue>, verify p256 signature over exact raw bytes, parse after
/home/steve-opacity/git/sdk/ra-verify/src/types/tcb_info.rs
Expected MRENCLAVE fetched from the attested server itself is TOFU — proves "genuine SGX", not "reviewed code"
pin out-of-band: reproducible build + gramine-sgx-quote-view / gramine-sgx-sigstruct-view
/home/steve-opacity/git/sdk/sdk/src/flows/functions/generate_proof_utils/collateral_provider.rs, tee-proxy-tls/README.sgx.md
MRSIGNER extracted but unenforced — trust pinned purely on MRENCLAVE
deliberate when signing keys are ephemeral (fresh key per docker build); know that sealing keys derived from MRSIGNER then don't survive rebuilds
/home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs
Treating missing x-response-quote as OK on error responses
hard-fail on missing response quote regardless of status code
opacity-stack tests
Gramine-returned private key parses as PKCS#8 DER, SEC1 DER, or PEM
try DER first, fall back to PEM on ----- prefix
/home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs
ra_tls_create_key_and_crt_der buffers are C-allocated
copy then libc::free
/home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs
First DCAP verification cold-fetches collateral and can blow a 15s handshake budget
verifier-side cert cache + writable QCNL cache dir (Gramine: tmpfs /var/cache, see sgx-gramine); optionally warm up at startup
opacity-stack history (deleted warmup_dcap())
Accepting only UpToDate TCB bricks real clusters
explicit policy for SW_HARDENING_NEEDED / CONFIG_NEEDED variants; hard-fail collateral_expiration_status != 0; see sgx-attestation for TCB policy
both repos
unwrap()/expect() on collateral signature parse = remote DoS
return Err (known footgun in /home/steve-opacity/git/sdk/ra-verify/src/types/tcb_info.rs)
sdk
CRL check by bare serial, unscoped to issuer
fine for Intel's small PKI only; don't copy into a general verifier
/home/steve-opacity/git/sdk/ra-verify/src/pki.rs
7. Decision guide
Question
Answer
Mutual or one-way?
Mutual when both ends are enclaves that must trust each other (service mesh — Pattern A). One-way when the client can't attest (mobile, browser bridge, CLI — Pattern B).
Intel QVL (tee_verify_quote) or pure-Rust verifier?
QVL when you control the host (Linux server, can install libsgx-dcap-quote-verify, point QCNL at PCCS); it self-fetches collateral with None. Pure-Rust (ra-verify-style) when the verifier runs where Intel libs can't (iOS/Android/wasm) or you want no C deps — but you own collateral fetching and TCB policy.
Cert lifetime
Gramine attest-side knobs RA_TLS_CERT_TIMESTAMP_NOT_BEFORE / RA_TLS_CERT_TIMESTAMP_NOT_AFTER (https://gramine.readthedocs.io/en/stable/attestation.html, as of 2026-06-11). Mostly cosmetic: RA-TLS verifiers ignore validity dates; freshness comes from EKM quotes, not cert lifetime.
Gramine's own verifier or custom?
ra_tls_verify_dcap.so works for C/preload setups; since Gramine v1.8 its RA_TLS_MRENCLAVE/RA_TLS_MRSIGNER/RA_TLS_ISV_PROD_ID/RA_TLS_ISV_SVN env vars MUST be set explicitly ("any" skips a check) — https://api.github.com/repos/gramineproject/gramine/releases/tags/v1.8 (as of 2026-06-11). Rust stacks need custom rustls verifiers anyway. More knobs: sgx-gramine.
Version facts to re-check before upgrades (all as of 2026-06-11):
Component
State
Source
Gramine
v1.9 (2025-06-20) is latest; no v1.10; mainline dormant since then. Pin a version tag, not stable-jammy — floating tag silently changes MRENCLAVE-relevant runtime
https://github.com/gramineproject/gramine/releases/tag/v1.9
rustls
0.23.40 (2026-04-28) latest stable; 0.24.0-dev.0 published 2026-01-28 — dangerous custom-verifier APIs may shift in 0.24, pin 0.23.x until audited
https://crates.io/api/v1/crates/rustls/versions
intel-tee-quote-verification-rs
0.3.0 (2023-10-24) is latest on crates.io but dormant; in-tree DCAP source advanced without republishing. Actively published fork: matter-labs teepot-tee-quote-verification-rs 0.6.0 (2025-06-25)
https://crates.io/crates/intel-tee-quote-verification-rs
DCAP packages
1.26 (2026-04-30): sgx_qve_header.h moved out of libsgx-dcap-quote-verify-dev into libsgx-headers >= 2.29 — bindgen/check images must add it
https://github.com/intel/confidential-computing.tee.dcap/releases/tag/DCAP_1.26
4. SGX Troubleshooting
Skill: sgx-troubleshooting — symptom-first SGX debugging knowledge.
SGX Troubleshooting
Staleness check (do this first): Facts below were verified against live Intel/Gramine sources on 2026-06-11. The SGX ecosystem moves fast and Intel renames/relocates repos. Before relying on any version number, URL, API shape, or deprecation status for a real decision, re-verify it online (WebSearch/WebFetch). Prefer official sources: github.com/intel/confidential-computing.sgx (ex linux-sgx), github.com/intel/confidential-computing.tee.dcap (ex SGXDataCenterAttestationPrimitives), download.01.org, api.portal.trustedservices.intel.com, gramine.readthedocs.io. Treat any dated claim older than ~6 months as suspect until re-checked.
Sibling skills: sgx-attestation (quote binary formats/offsets, collateral concepts, scripts/inspect_quote.py), sgx-ratls (RA-TLS design patterns, EKM binding), sgx-gramine (manifest syntax, deprecations table, toolchain, reproducible MRENCLAVE). This skill is the symptom-first entry point.
1. Triage flowchart
What failed?├─ Process dies/refuses to start under gramine-sgx ............... (a) enclave won't load├─ Writing/reading /dev/attestation/* errors, AESM errors ........ (b) quote generation fails├─ tee_verify_quote / verifier returns non-OK or panics .......... (c) quote verification fails├─ TLS handshake rejected, cert extension missing, EKM mismatch,│  x-request-quote / x-response-quote rejected ................... (d) TLS / RA-TLS layer fails└─ Errors mention PCCS/QCNL/collateral, 404s, timeouts,   collateral_expiration_status != 0 ............................. (e) collateral / PCCS fails
First command for each:
Path
First command
What it tells you
(a)
bash scripts/check-sgx-env.sh (in this skill dir)
devices, cpu flags, driver, packages
(b)
inside Gramine: ls /dev/attestation/; on host: systemctl status aesmd
pseudo-files present, AESM alive
(c)
log/print the sgx_ql_qv_result value, look it up in §3
TCB policy vs broken quote vs collateral
(d)
`openssl s_client -connect host:port -showcerts </dev/null \
openssl x509 -text \
grep -A2 1337`
is the quote extension even in the cert
(e)
curl -ks https://<pccs-host>:8081/sgx/certification/v4/rootcacrl
PCCS reachable and serving v4
Path (a) sub-checks: /dev/sgx_enclave missing → kernel/BIOS/container device mapping. Devices present but Gramine fails fast → manifest schema error (renamed keys, §5) or unsigned/stale .manifest.sgx. Loads then dies → memory exhaustion (§5). For opaque load failures set loader.log_level = "debug" in the manifest (replaced loader.debug_type in Gramine v1.5) and re-sign before re-running.
Path (b) sub-checks:
AESM dead or socket not mounted into the container (/var/run/aesmd/aesm.socket) → quote generation hangs or errors. SGX_AESM_ADDR set = out-of-process quoting via AESM; unset = in-process (app loads QE3/PCE itself via libsgx_dcap_ql) (https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_SGX_ECDSA_QuoteLibReference_DCAP_API.pdf, as of 2026-06-11).
/dev/sgx_provision missing or wrong group → PCE cannot access the provisioning key; quoting fails even though enclaves load fine.
Inside Gramine: write exactly 64 bytes to /dev/attestation/user_report_data, then read /dev/attestation/quote. Wrong report_data appearing in quotes under load = the concurrency race in §5.
Path (c) sub-checks: distinguish "the verify call itself failed" (plumbing: missing QPL, no QCNL config, PCCS unreachable — go to (e)) from "the call returned a non-OK sgx_ql_qv_result" (TCB policy or broken quote — §3). With None collateral the QVL fetches via QPL/QCNL, so most (c) failures are really (e).
Path (d) sub-checks: extension present in the cert but the verifier can't find it → OID double-encoding (§6). Handshake succeeds but per-request quote headers rejected → EKM/freshness mismatch (§6).
2. Environment checklist — scripts/check-sgx-env.sh
Run bash /home/steve-opacity/.claude/skills/sgx-troubleshooting/scripts/check-sgx-env.sh. Read-only, no sudo, always exits 0. What each check means:
Check
PASS means
FAIL usually means
cpuinfo sgx flag
CPU+BIOS expose SGX
BIOS disabled, unsupported CPU, VM without SGX passthrough. Note: SGX is deprecated/absent on 11th/12th-gen+ client Core CPUs — server Xeon only (https://en.wikipedia.org/wiki/Software_Guard_Extensions, as of 2026-06-11)
cpuinfo sgx_lc flag
Flexible Launch Control present
DCAP and the upstream kernel driver require FLC; non-FLC is unsupported (https://www.kernel.org/doc/html/latest/arch/x86/sgx.html, as of 2026-06-11)
/dev/sgx_enclave + /dev/sgx_provision
in-kernel driver loaded; container has devices mapped
in-kernel driver missing/not exposed, or container lacks --device. Legacy /dev/isgx = old out-of-tree driver, unsupported (Gramine dropped it in v1.9, https://github.com/gramineproject/gramine/releases/tag/v1.9, 2025-06-20)
/dev/attestation/quote
you are INSIDE Gramine with attestation configured
absent on the host is normal; absent inside Gramine means sgx.remote_attestation = "dcap" not set
aesmd active
quote generation service available
install/start sgx-aesm-service; containers need /var/run/aesmd/aesm.socket mounted. SGX_AESM_ADDR set = out-of-process quoting via AESM (https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_SGX_ECDSA_QuoteLibReference_DCAP_API.pdf, as of 2026-06-11)
libsgx-* packages
DCAP runtime libs installed
add Intel apt repo download.01.org/intel-sgx/sgx_repo/ubuntu. Current jammy DCAP packages: 1.26.100.1-jammy1 (DCAP 1.26, 2026-04-30, https://github.com/intel/confidential-computing.tee.dcap/releases/tag/DCAP_1.26)
gramine-sgx / gramine-manifest
toolchain on PATH
latest Gramine is v1.9 (2025-06-20); no newer release as of 2026-06-11 and mainline is dormant (https://github.com/gramineproject/gramine/releases/tag/v1.9). Pin image tags, not stable-jammy
/etc/sgx_default_qcnl.conf + endpoint probe
QPL knows where PCCS is and it answers
quote verification with None collateral will fail/hang on cold fetch
EPC size (dmesg)
informational
dmesg often restricted without root → SKIP is normal
Useful one-liners once the environment is sane:
gramine-sgx-sigstruct-view app.sig | grep mr_enclave   # measured MRENCLAVE from the signature filegramine-sgx-quote-view quote.bin                       # decode a quote (renamed from gramine-sgx-quote-dump in v1.5)ss -lx | grep aesm                                     # AESM socket actually listening (containers: must be mounted)curl -ks "$(grep -Eo 'https?://[^" ,]+' /etc/sgx_default_qcnl.conf | head -1)rootcacrl"   # PCCS liveness
Byte-level quote inspection: sgx-attestation scripts/inspect_quote.py.
Checking SGX-gated code without SGX hardware: bindgen-based crates (intel-tee-quote-verification-sys) need the DCAP header sgx_dcap_quoteverify.h plus a working LIBCLANG_PATH even for cargo check. Pattern: a slim Docker image with only libsgx-dcap-quote-verify-dev (no runtime libs, no devices) running cargo check --features sgx. Examples: /home/steve-opacity/git/opacity-stack/Dockerfile.sgx-check, /home/steve-opacity/git/sdk/Dockerfile.sgx-check. Since DCAP 1.26, also install libsgx-headers if anything includes sgx_qve_header.h (§7).
3. Quote verification result table (sgx_ql_qv_result)
Semantics per Intel SGX ECDSA QuoteLibReference DCAP API (https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_SGX_ECDSA_QuoteLibReference_DCAP_API.pdf, doc set dated 2026-04-30, fetched 2026-06-11):
Result
Meaning
Typical fix
OK
Quote valid, TCB up to date
Accept
CONFIG_NEEDED
Quote valid; platform needs BIOS/config change per advisory
Policy decision: apply BIOS config, or accept with logged advisory IDs in dev/staging
OUT_OF_DATE
Platform TCB (microcode/PSW) below current TCB level
TCB recovery: update microcode/BIOS + PSW on the QUOTING platform, regenerate quote. Collateral refresh won't fix this
OUT_OF_DATE_CONFIG_NEEDED
Both of the above
Microcode/BIOS update + config change
SW_HARDENING_NEEDED
Platform TCB current, but enclave software should carry mitigations for the listed advisories
Policy decision: accept if enclave is built with the mitigations the advisory IDs require
CONFIG_AND_SW_HARDENING_NEEDED
Config + SW hardening both needed
Combination policy; common on real hardware with active advisories — rejecting outright bricks dev clusters (see /home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs: accepted with log, plan to reject in prod)
INVALID_SIGNATURE
Signature chain over the quote does not verify
Broken quote bytes: truncated/corrupted hex, wrong offsets, v4/v5 quote parsed as v3, mangled PCK chain. Inspect with sgx-attestation scripts/inspect_quote.py
REVOKED
TCB level or key revoked
Hard reject. Platform needs TCB recovery; if it persists after updates, hardware is burned
UNSPECIFIED
Verification could not complete
Almost always collateral/QPL plumbing — go to §4
collateral_expiration_status != 0: some collateral piece (TCB info, CRL, QE identity) is expired relative to the verifier's expiration check date. Fixes in order: (1) refresh PCCS cache (restart PCCS or call its refresh endpoint; QCNL caches per verify_collateral_cache_expire_hours); (2) check whether PCCS pulls update=early vs update=standard TCB info — PCS v4 serves early access at TCB-recovery disclosure vs standard ~12 months later (https://api.portal.trustedservices.intel.com/content/documentation.html, as of 2026-06-11); (3) check the VERIFIER's clock — a skewed clock makes valid collateral look expired.
TCB-policy state: latest TCB Evaluation Data Number is 21, tied to the 2026-02-10 TCB recovery (https://api.trustedservices.intel.com/sgx/certification/v4/tcbevaluationdatanumbers, fetched 2026-06-11). A PCCS holding pre-recovery collateral verifies quotes against stale levels — refresh after every TCB recovery event.
Known scheduled change — 2026-08-12 (~11pm PT): PCS switches update=standard (and the default) to TCB-R 20 collateral (the 2025-08-12 recovery; early track already serves 21). Symptom to expect: verification that was OK suddenly returns OUT_OF_DATE / OUT_OF_DATE_CONFIG_NEEDED around that date on platforms missing TCB-R 20 mitigations — Intel names 4th/5th Gen Xeon Scalable and Xeon 6 P-cores as affected. Fixes: apply the TCB-R 20 microcode/BIOS + PSW updates on quoting platforms, refresh PCCS, or pin tcbEvaluationDataNumber=19 short-term while rolling out (see §4). Source: Intel Confidential Computing Team customer email (received 2026-06-12); cross-checked against the live tcbevaluationdatanumbers endpoint 2026-06-12.
If verification uses Gramine's ra_tls_verify_dcap.so instead of the QVL directly, the corresponding accept/reject knobs are env vars: RA_TLS_ALLOW_OUTDATED_TCB_INSECURE, RA_TLS_ALLOW_HW_CONFIG_NEEDED, RA_TLS_ALLOW_SW_HARDENING_NEEDED, RA_TLS_ALLOW_DEBUG_ENCLAVE_INSECURE (the single outdated-TCB knob was split into three in Gramine v1.5; all "0" for prod) (https://gramine.readthedocs.io/en/stable/attestation.html, Gramine v1.9, as of 2026-06-11). Details in sgx-gramine.
4. Collateral / PCCS failures
PCS API is v4 only. v2/v3 reached EOL and are gone (https://api.portal.trustedservices.intel.com/content/documentation.html, as of 2026-06-11). QCNL config /etc/sgx_default_qcnl.conf must point at a PCCS serving /sgx/certification/v4/.
QPL → PCCS plumbing: tee_verify_quote(quote, None, ...) with None collateral makes the QVL fetch via QPL/QCNL. No /etc/sgx_default_qcnl.conf (or bad SGX_QCNL_CONFIG_PATH override) → UNSPECIFIED-style failures. Self-signed PCCS needs use_secure_cert: false (collateral is independently Intel-signed). Working example: /home/steve-opacity/git/opacity-stack/sgx_default_qcnl.conf (self-hosted PCCS :8081, retry_times/retry_delay, 168h caches).
No writable cache = silent re-fetch every call. QPL caches under /var/cache; inside Gramine that's missing by default and QPL does NOT error — it re-hits PCCS inside every TLS handshake. Mount /var/cache as tmpfs (see /home/steve-opacity/git/opacity-stack/manifest.template). Related: first cold fetch can blow a 15s handshake timeout.
PCK chain decode traps (cause downstream "chain verification failed" that looks like crypto): PCS v4 returns issuer chains URL-encoded in response headers (TCB-Info-Issuer-Chain, SGX-PCK-CRL-Issuer-Chain, ...) — urldecode + trim each line; /rootcacrl body is a hex string (sometimes quoted), not DER; the PCK PEM chain embedded in the quote has a trailing NUL byte — strip before PEM parsing. Examples: /home/steve-opacity/git/sdk/sdk/src/flows/functions/generate_proof_utils/collateral_provider.rs, /home/steve-opacity/git/sdk/ra-verify/src/types/quote.rs.
Signed JSON must be verified over raw bytes. TCB info / QE identity signatures cover the exact tcbInfo/enclaveIdentity JSON; round-tripping through serde maps breaks them. Keep RawValue (see /home/steve-opacity/git/sdk/ra-verify/src/types/tcb_info.rs).
TCB evaluation data number mismatches. Collateral pieces fetched at different evaluation numbers (e.g. TCB info post-recovery, QE identity pre-recovery) can fail verification together. PCS v4 supports pinning via the tcbEvaluationDataNumber parameter (410 Gone if too old, 404 if not yet published; cannot be combined with update= in one request) — refetch the whole collateral set atomically or pin the number (https://api.portal.trustedservices.intel.com/content/documentation.html, as of 2026-06-11).
PCCS relocation: PCCS source moved to its own repo intel/confidential-computing.tee.dcap.pccs as of DCAP 1.24 (2025-12-22); current release 1.26 (2026-04-30) — last release supporting Node.js < v22 (https://github.com/intel/confidential-computing.tee.dcap.pccs/releases, as of 2026-06-11).
5. Gramine-specific failures
Symptom
Cause
Fix
Manifest parse/schema error on keys that "used to work"
Renamed/removed keys: sgx.thread_num→sgx.max_threads (removed v1.5), sgx.protected_files→fs.mounts type="encrypted" (v1.5), sgx.require_avx→sgx.cpu_features.* (v1.8), boolean sgx.remote_attestation→string "dcap"/"none", "epid" removed in v1.9
See the deprecations table in sgx-gramine. Sources: https://api.github.com/repos/gramineproject/gramine/releases/tags/v1.5, .../v1.8, https://github.com/gramineproject/gramine/releases/tag/v1.9 (as of 2026-06-11)
Crashes/ENOMEM under load, thread spawn failures
sgx.enclave_size (default "256M" non-EDMM) or sgx.max_threads (default 4) exhausted; glibc per-thread malloc arenas balloon committed memory
Raise enclave_size/max_threads; set loader.env.MALLOC_ARENA_MAX = "1"; bump sys.stack.size (default "256K"; opacity-stack needed "8M" after crashes). Defaults: https://gramine.readthedocs.io/en/stable/manifest-syntax.html (v1.9, as of 2026-06-11). EDMM (sgx.edmm_enable, default false) makes enclave_size a growth cap
"Disallowing access to file" / file rejected after rebuild
Binary or library changed but .manifest.sgx still carries old sgx.trusted_files hashes
Re-run gramine-manifest + gramine-sgx-sign after ANY change to measured files
Peers reject MRENCLAVE after a "harmless" change
ANY manifest delta changes the measurement: env var values templated into the manifest, trusted-file hashes, enclave size, Gramine version itself (floating stable-jammy tag silently jumped v1.8→v1.9)
Re-measure: gramine-sgx-sigstruct-view app.sig, update allowlists. Pin Gramine image versions. Example two-pass CI: /home/steve-opacity/git/opacity-stack/.github/workflows/docker-image-build.yaml
Quotes carry the WRONG report_data under concurrency
/dev/attestation/user_report_data write + /dev/attestation/quote read are two non-atomic ops; concurrent generators interleave
Hold a process-global mutex around the write+read pair; it's blocking I/O (talks to AESM) so use spawn_blocking on async runtimes. Examples: /home/steve-opacity/git/opacity-stack/ratls/src/attestation.rs, /home/steve-opacity/git/sdk/tee-proxy-tls/src/freshness.rs
Env var mysteriously unset inside enclave
Host env does not pass through unless loader.env.NAME = { passthrough = true }
Declare it in the manifest; watch for silent fallbacks (e.g. sqlx default URL)
TLS root loading slow or flaky inside the enclave
rustls/openssl probing hashed cert files under /etc/ssl/certs through Gramine's FS shim
Pin loader.env.SSL_CERT_FILE to the single ca-certificates.crt bundle and list it in sgx.trusted_files (see /home/steve-opacity/git/opacity-stack/manifest.template)
Sealed data unreadable after image rebuild
Running gramine-sgx-gen-private-key per build changes MRSIGNER, and SGX sealing keys derive from it
Use one stable enclave-key.pem (default path ~/.config/gramine/enclave-key.pem, RSA-3072 exponent 3: https://gramine.readthedocs.io/en/stable/manpages/gramine-sgx-gen-private-key.html, Gramine v1.9)
Orphaned loader ... child N processes after kills
Gramine enclaves don't reliably die with their parent
Hunt ppid==1 loader processes in test cleanup (see /home/steve-opacity/git/opacity-stack/scripts/test-common.sh)
6. RA-TLS failures
Design patterns live in sgx-ratls; these are the debugging-time symptoms:
Quote extension not found in cert. Gramine's legacy OID is 1.2.840.113741.1337.6, but in Gramine-generated certs it appears DOUBLE-ENCODED: x509-parser sees components [0,6,9,42,840,113741,1337,6] (the inner DER TLV wrapped again). Naive matching against the dotted form fails. Since v1.8 certs ALSO carry the Interoperable RA-TLS TCG DICE OID (2.23.133.5.4.9, CBOR); the legacy OID is deprecated with planned removal (https://gramine.readthedocs.io/en/stable/attestation.html, as of 2026-06-11). Example matcher: /home/steve-opacity/git/sdk/sdk/src/flows/functions/generate_proof_utils/ra_tls_verifier.rs.
report_data key-binding mismatch (report_data[0..32] != SHA256(cert SPKI)): cert was regenerated but a cached quote is being served, or vice versa — cert and quote must be produced together (Gramine's ra_tls_create_key_and_crt_der does both at once). Skipping this check lets a stolen valid quote pair with an attacker key.
EKM (nonce) mismatch on per-request quotes: both sides must call export_keying_material with the identical label and context=None; a pooled/reused connection has a DIFFERENT EKM than a fresh one, so cached quotes from a previous connection fail. Either bind quote cache to the connection (byte-compare on reuse, evict on drift — /home/steve-opacity/git/sdk/sdk/src/flows/functions/generate_proof_utils/notary_https_client.rs) or open fresh connections. reqwest cannot do this — it doesn't expose the rustls connection; hand-roll tokio_rustls+hyper.
Missing x-response-quote on error paths: the attested-response header must be attached even on non-2xx responses, or clients hard-fail exactly when you need the error body. Middleware example: /home/steve-opacity/git/opacity-stack/ratls/src/server/middleware.rs.
Clock skew vs injected time: verifiers take current_time as a parameter; SystemTime::now() is host-controlled inside some TEEs and spoofable on clients. A skewed verifier clock produces cert-validity/collateral-expiry failures with perfectly good collateral.
Custom rustls verifiers must still verify handshake signatures (verify_tls12/13_signature) — returning success unconditionally lets a MITM present the attested cert without the key.
7. Library landmines
Library
Status (as of 2026-06-11)
Landmine
intel-tee-quote-verification-rs
0.3.0 IS the latest crates.io release, published 2023-10-24; not deprecated but dormant — Intel updates in-tree source without publishing (https://crates.io/crates/intel-tee-quote-verification-rs)
Wraps current libsgx-dcap-quote-verify fine. Actively-published fork if newer QVL coverage needed: matter-labs teepot-tee-quote-verification-rs 0.6.0 (2025-06-25, github.com/matter-labs/teepot). The -sys crate needs DCAP headers + libclang even for cargo check
libsgx-dcap-quote-verify(-dev)
1.26.100.1-jammy1, DCAP 1.26, 2026-04-30 (https://github.com/intel/confidential-computing.tee.dcap/releases/tag/DCAP_1.26)
DCAP 1.26 REMOVED sgx_qve_header.h from the -dev package — it now ships in libsgx-headers >= 2.29; build images including that header must add the package or builds break
ra-verify (libsignal-derived pure-Rust DCAP, /home/steve-opacity/git/sdk/ra-verify)
in-repo
as_tcb_info_and_verify in src/types/tcb_info.rs PANICS (unwrap/expect) on malformed/invalid TCB-info signatures instead of returning Err — DoS-grade footgun if copied (qe_identity.rs does it correctly with ?)
ra-verify TrustStore (src/pki.rs)
in-repo
CRL matching is by BARE serial number unscoped to issuer — any cert whose serial appears in any loaded CRL is treated revoked. Tolerable for Intel's small PKI; wrong for a general verifier
Quote parsers with hard-coded offsets
v3 only
MRENCLAVE@112, report_data@368, min length 432 are quote-v3 specific; v4/v5 formats differ (Intel TDX DCAP Quoting Library API, https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_TDX_DCAP_Quoting_Library_API.pdf, as of 2026-06-11). Gate on the version u16 at offset 0 before offset reads. Details in sgx-attestation
Anything EPID
DEAD: IAS EOL 2025-04-02 (https://community.intel.com/t5/Intel-Software-Guard-Extensions/IAS-End-of-Life-Announcement/td-p/1545831); EPID code removed in PSW 2.28 (https://raw.githubusercontent.com/intel/confidential-computing.sgx/main/README.md); Gramine removed "epid" in v1.9
If a failure trail leads to EPID/IAS code paths, the fix is migration to DCAP, not debugging
Intel apt signing key
intel-sgx-deb.key expires 2027-03-20 (https://download.01.org/intel-sgx/sgx_repo/ubuntu/intel-sgx-deb.key, as of 2026-06-11)
Dockerfiles curling the key at build time will break at expiry unless Intel rotates
UNVERIFIED (flagged as gaps in the findings — re-check before relying on them):
Exact rename date of the Intel GitHub repos to confidential-computing.* (before or after Jan 2026 unknown; old URLs redirect).
Default quote version (4 vs 5) emitted by current QGS/QE builds in production.
EDMM minimum CPU/kernel requirements (which Xeon generations / kernel versions).
IAS EOL date (2025-04-02) rests on web-search snippets of the Intel Community announcement — intel.com 403s direct fetches — corroborated by the PSW README and Gramine docs.
Appendix A — check-sgx-env.sh
Read-only SGX/Gramine/DCAP environment checker (ships with sgx-troubleshooting). No sudo; always exits 0.
#!/usr/bin/env bash# check-sgx-env.sh -- read-only SGX/Gramine/DCAP environment checks; no sudo needed; always exits 0# Usage: bash check-sgx-env.shset -uPASS=0; FAIL=0; SKIP=0pass() { echo "PASS  $1"; PASS=$((PASS+1)); }fail() { echo "FAIL  $1"; FAIL=$((FAIL+1)); }skip() { echo "SKIP  $1"; SKIP=$((SKIP+1)); }note() { echo "NOTE  $1"; }if [ -r /proc/cpuinfo ]; then  if grep -qw sgx /proc/cpuinfo; then    pass "cpu flag 'sgx' present"  else    fail "cpu flag 'sgx' missing -- SGX off in BIOS, unsupported CPU, or VM without SGX passthrough"  fi  if grep -qw sgx_lc /proc/cpuinfo; then    pass "cpu flag 'sgx_lc' present (Flexible Launch Control)"  else    fail "cpu flag 'sgx_lc' missing -- upstream kernel driver and DCAP attestation require FLC"  fielse  skip "/proc/cpuinfo not readable -- cannot check cpu flags"fiif [ -e /dev/sgx_enclave ]; then  pass "/dev/sgx_enclave exists"else  fail "/dev/sgx_enclave missing -- in-kernel driver not loaded (kernel >=5.11 + BIOS enable); containers need --device=/dev/sgx_enclave"fiif [ -e /dev/sgx_provision ]; then  pass "/dev/sgx_provision exists"else  fail "/dev/sgx_provision missing -- required for DCAP quoting; check device mapping and group permissions"fiif [ -e /dev/isgx ]; then  note "legacy /dev/isgx present -- old out-of-tree driver, unsupported (Gramine >=1.9 requires the in-kernel driver)"fiif [ -e /dev/attestation/quote ]; then  pass "inside Gramine: /dev/attestation/quote present"else  skip "/dev/attestation/quote absent -- not running inside Gramine (normal on the host; inside Gramine check sgx.remote_attestation=\"dcap\")"fiif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet aesmd 2>/dev/null; then  pass "aesmd service active (systemctl)"elif pgrep -x aesm_service >/dev/null 2>&1; then  pass "aesmd running (pgrep aesm_service)"else  fail "aesmd not running -- install/start sgx-aesm-service; containers need /var/run/aesmd/aesm.socket mounted"fiif command -v dpkg >/dev/null 2>&1; then  PKGS=$(dpkg -l 2>/dev/null | awk '$1=="ii" && ($2 ~ /^libsgx/ || $2 ~ /^sgx-aesm/) {print "      "$2" "$3}')  if [ -n "$PKGS" ]; then    pass "libsgx/sgx-aesm packages installed (dpkg):"    echo "$PKGS"  else    fail "no libsgx-*/sgx-aesm-service packages (dpkg) -- add Intel apt repo download.01.org/intel-sgx/sgx_repo/ubuntu"  fielif command -v rpm >/dev/null 2>&1; then  PKGS=$(rpm -qa 2>/dev/null | grep -E '^(libsgx|sgx-aesm)' | sed 's/^/      /')  if [ -n "$PKGS" ]; then    pass "libsgx/sgx-aesm packages installed (rpm):"    echo "$PKGS"  else    fail "no libsgx-*/sgx-aesm-service packages (rpm) -- install Intel SGX PSW/DCAP packages"  fielse  skip "neither dpkg nor rpm available -- cannot list SGX packages"fifor TOOL in gramine-sgx gramine-manifest; do  if command -v "$TOOL" >/dev/null 2>&1; then    V=$("$TOOL" --version 2>/dev/null | head -1)    pass "$TOOL on PATH (${V:-version unknown})"  else    fail "$TOOL not on PATH -- install Gramine or use a gramineproject/gramine image (pin a version tag, not stable-*)"  fidoneif [ -r /etc/sgx_default_qcnl.conf ]; then  pass "/etc/sgx_default_qcnl.conf present"  grep -Ei 'pccs_url|collateral_service|use_secure_cert' /etc/sgx_default_qcnl.conf 2>/dev/null | sed 's/^[[:space:]]*/      /'  if command -v curl >/dev/null 2>&1; then    URL=$(grep -Eo 'https?://[^" ,]+' /etc/sgx_default_qcnl.conf 2>/dev/null | head -1)    if [ -n "${URL:-}" ]; then      CODE=$(curl -ks -o /dev/null -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null)      if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then        pass "collateral endpoint reachable: $URL (HTTP $CODE)"      else        fail "collateral endpoint unreachable: $URL -- PCCS down/firewalled; cold DCAP verification will fail or stall"      fi    else      skip "no URL found in qcnl conf to probe"    fi  else    skip "curl not installed -- cannot probe PCCS endpoint"  fielse  fail "/etc/sgx_default_qcnl.conf missing -- QPL cannot locate PCCS; tee_verify_quote with None collateral will fail"fiEPC=$(dmesg 2>/dev/null | grep -iE 'sgx:.*EPC' | head -5)if [ -n "$EPC" ]; then  pass "EPC info from dmesg:"  echo "$EPC" | sed 's/^/      /'elif [ -r /proc/cpuinfo ] && grep -qw sgx /proc/cpuinfo; then  skip "EPC size unknown -- dmesg restricted (needs root); /proc/cpuinfo confirms sgx but does not expose EPC size"else  skip "EPC size unknown -- dmesg restricted and no sgx flag in /proc/cpuinfo"fiechoecho "Summary: $PASS pass, $FAIL fail, $SKIP skip"exit 0
Appendix B — inspect_quote.py
Stdlib-only SGX DCAP quote v3 field dumper (ships with sgx-attestation).
#!/usr/bin/env python3# Usage: inspect_quote.py QUOTE_FILE | inspect_quote.py --hex 0xDEAD... | inspect_quote.py --b64 BASE64#        Prints SGX DCAP quote v3 fields. Non-v3 quotes exit 1 unless --force.import argparseimport base64import binasciiimport structimport sysdef load(args, parser):    if args.hex:        s = args.hex.strip()        if s.startswith("0x") or s.startswith("0X"):            s = s[2:]        return binascii.unhexlify("".join(s.split()))    if args.b64:        return base64.b64decode(args.b64.strip())    if args.file:        with open(args.file, "rb") as f:            return f.read()    parser.error("provide a quote file path, --hex, or --b64")def main():    parser = argparse.ArgumentParser(prog="inspect_quote.py")    parser.add_argument("file", nargs="?")    parser.add_argument("--hex")    parser.add_argument("--b64")    parser.add_argument("--force", action="store_true")    args = parser.parse_args()    data = load(args, parser)    def row(label, value):        print(f"{label:<26}{value}")    if len(data) < 2:        sys.exit(f"error: quote is {len(data)} bytes; need at least 2 to read version")    version = struct.unpack_from("<H", data, 0)[0]    row("quote_version", version)    if version != 3:        print(f"WARNING: quote version is {version}, not 3. All field offsets in this "              "tool are v3-only; v4/v5 (TDX-era) layouts differ and values below would be garbage.")        if not args.force:            sys.exit(1)    if len(data) < 432:        sys.exit(f"error: quote is {len(data)} bytes; v3 minimum is 432 "                 "(48-byte header + 384-byte report body)")    u16 = lambda off: struct.unpack_from("<H", data, off)[0]    row("att_key_type", f"{u16(2)} (2 = ECDSA-P256)")    row("qe_svn", u16(8))    row("pce_svn", u16(10))    row("qe_vendor_id", data[12:28].hex())    row("user_data", data[28:48].hex())    row("mrenclave", data[112:144].hex())    row("mrsigner", data[176:208].hex())    row("isv_prod_id", u16(304))    row("isv_svn", u16(306))    row("report_data[0..32]", data[368:400].hex())    row("report_data[32..64]", data[400:432].hex())    if len(data) >= 436:        declared = struct.unpack_from("<I", data, 432)[0]        actual = len(data) - 436        status = "OK" if declared == actual else "MISMATCH"        row("sig_data_len declared", declared)        row("sig_data_len actual", f"{actual} ({status})")    else:        row("sig_data_len", "absent (quote ends at report body)")    tail = data[432:]    row("pck_chain_embedded", "yes" if b"CERTIFICATE" in tail else "no")if __name__ == "__main__":    main()

