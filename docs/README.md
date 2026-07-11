# Breadbrich Engels Documentation

Design documents and developer references for Breadbrich Engels (the organization's AI assistant).

| Document                                                       | Description                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [SPEC.md](SPEC.md)                                             | Architecture and system design                                                           |
| [SECURITY.md](SECURITY.md)                                     | Security model and container isolation                                                   |
| [REQUIREMENTS.md](REQUIREMENTS.md)                             | Requirements and design decisions                                                        |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md)                           | Claude Agent SDK integration details                                                     |
| [skills-as-branches.md](skills-as-branches.md)                 | Skills system (branch-based)                                                             |
| [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)                       | Troubleshooting guide                                                                    |
| [docker-sandboxes.md](docker-sandboxes.md)                     | Docker container sandboxing                                                              |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | Apple Container runtime                                                                  |
| [KUBERNETES.md](KUBERNETES.md)                                 | Kubernetes container runtime (`CONTAINER_RUNTIME=kubernetes`), hosted multi-tenant model |
| [TEE.md](TEE.md)                                               | TEE deployment mode (dstack/Phala Intel-TDX): full stack in one CVM, `!verify` attestation, Signal-in-enclave |
