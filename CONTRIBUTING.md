# Contributing

Read `AGENTS.md` first. Changes must preserve persistent authorization, immediate revoke/Emergency Stop, project isolation, audit redaction, atomic/recoverable mutation, and truthful capability reporting.

Use Node.js `>=24.15 <25`, run `npm ci`, and make the smallest cohesive change. Add a failing test before implementation. Test categories are `tests/unit`, `contract`, `integration`, `security`, `fault`, and `acceptance`. A feature that only works in a mock is not accepted; optional machine capabilities must report `unavailable` with a reason.

Before proposing a release:

```powershell
npm run inventory
npm run typecheck
npm run build
npm test
.\scripts\release\verify.ps1
```

Do not commit `var/`, databases, logs, backups, owner tokens, signing keys, browser profiles, credential material, generated media, or user project content. Redact issue reports. Document new environment requirements and recovery steps. Tool changes require regenerated `config/tool-inventory.v1.json` and `docs/TOOL_INVENTORY.md`; behavior changes require `CHANGELOG.md` and the relevant architecture/security/operator document.

Pull requests should explain the user-visible behavior, security implications, tests run, optional capabilities not exercised, and rollback path. Reviewers must reject any change that bypasses identity binding, caches authorization beyond a step, leaks secret values, mutates project content unexpectedly, or claims live system acceptance without evidence.
