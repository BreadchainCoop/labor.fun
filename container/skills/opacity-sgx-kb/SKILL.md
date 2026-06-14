---
name: opacity-sgx-kb
description: Opacity SGX / RA-TLS knowledge base — Intel SGX DCAP attestation, Gramine LibOS manifests & signing, RA-TLS (quote-in-cert) patterns, and symptom-first SGX troubleshooting. Use when working on confidential computing, enclaves, MRENCLAVE/MRSIGNER, DCAP quotes/collateral, Gramine builds, or debugging SGX/attestation errors. Opt-in skill (off by default) — enable per profile via enabledSkills.
default: false
---

# Opacity SGX / RA-TLS Knowledge Base

A reference compiled from the `sgx-gramine`, `sgx-ratls`, `sgx-attestation`, and
`sgx-troubleshooting` agent skills. It covers Intel SGX confidential computing
end to end: remote attestation, the Gramine LibOS toolchain, RA-TLS, and a
troubleshooting playbook.

> **Opt-in skill.** This skill ships disabled by default. It only loads in
> containers whose active profile enables it (`enabledSkills` in
> `profile.config.json`, or the `ENABLED_SKILLS` env var). See `docs/PLUGINS.md`
> → "Opt-in (off-by-default) skills".

> **Staleness:** facts were verified against live Intel/Gramine sources on
> **2026-06-11**. The SGX ecosystem moves fast and Intel renames/relocates
> repos — re-verify any version number, URL, API shape, or deprecation status
> with WebSearch/WebFetch before relying on it for a real decision.

## When to use this

Reach for this skill when a task touches:
- **Remote attestation** — DCAP quote/report structures, collateral (PCK, TCB,
  QE identity), TCB status policy, MRENCLAVE vs MRSIGNER, `report_data` binding.
- **Gramine SGX** — manifest syntax, the signing toolchain, reproducible
  MRENCLAVE, RA-TLS libraries, known deprecations.
- **RA-TLS** — quote-in-certificate TLS, writing custom rustls verifiers, EKM
  freshness / replay protection.
- **Troubleshooting** — symptom-first triage of SGX/attestation failures,
  error tables, and common library landmines.

## How to use it

The full reference lives in [`reference/sgx-ratls-kb.md`](reference/sgx-ratls-kb.md).
It's large, so don't read it wholesale — open it and jump to the relevant
section:

1. **SGX DCAP Attestation** — mental model, ecosystem state, quote formats,
   collateral, TCB policy.
2. **Gramine SGX LibOS** — manifest syntax, toolchain, deprecations, RA-TLS
   libs, reproducible MRENCLAVE.
3. **SGX RA-TLS** — quote-in-cert TLS, custom rustls verifiers, EKM freshness.
4. **SGX Troubleshooting** — symptom-to-cause checklists, error tables.
5. **Appendix A** — `check-sgx-env.sh` (environment sanity script).
6. **Appendix B** — `inspect_quote.py` (quote inspection helper).

Grep the reference for the symptom, error string, or term you need, read that
section, and re-verify anything version- or URL-specific online before acting.
