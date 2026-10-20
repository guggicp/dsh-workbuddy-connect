# Vendored upstreams

The protocol code is vendored so the Hermes plugin can run without a DSH process or DSH package installation. The snapshots are pinned to the commits below; the local fork remotes are `guggicp` and each clone also has the original project as `upstream`.

| Provider | Fork | Original project | Vendored version | Source commit |
| --- | --- | --- | --- | --- |
| WorkBuddy | [guggicp/dsh-workbuddy-connect](https://github.com/guggicp/dsh-workbuddy-connect) | [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | 0.7.9 | `f1e22c4854f1aa8007e3ec58759bfe3616504a2a` |
| Trae | [guggicp/dsh-connect-trae](https://github.com/guggicp/dsh-connect-trae) | [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | 4.0.1 | `9cfcc44367f606a57bdf61873a0454c23cf393a2` |
| Qoder | [guggicp/dsh-connect-qoder](https://github.com/guggicp/dsh-connect-qoder) | [eghrhegpe/dsh-connect-qoder](https://github.com/eghrhegpe/dsh-connect-qoder) | 0.7.3 | `664871728302ccb50ff44c49a3a01515ed6d4e4a` |

The Hermes-specific bridge imports only the protocol and credential modules it needs. DSH host adapters and UI modules are not part of the runtime import path. DSH home/file-lock helpers used by WorkBuddy and Trae were replaced in the vendored copies by the Hermes-local helpers in `vendor/hermes-deps.ts`. TypeScript constructor parameter properties were rewritten as explicit fields and assignments so Node's built-in TypeScript type stripping can load the modules without a separate compiler.

WorkBuddy daily check-in protocol reference: [corrinehu/dsh-buddy-checkin](https://github.com/corrinehu/dsh-buddy-checkin), commit `6517966808c7d19a14736ba9e59f7550c753afce` (MIT); only the request/response rules are adapted, not its DSH startup hooks or account scanner.
