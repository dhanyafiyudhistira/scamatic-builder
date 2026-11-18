# Windows code-signing release runbook

This runbook is the required path for producing a public SCAMATIC Builder Local
NSIS installer. `desktop:build:local` remains an unsigned development build and
must not be distributed as a production release.

## Security boundary

- Use a trusted Windows code-signing certificate with an accessible private key
  and the Code Signing EKU (`1.3.6.1.5.5.7.3.3`). An SSL/TLS certificate is not
  suitable.
- Never commit a PFX, private key, certificate password, or its Base64 encoding.
  Base64 is transport encoding, not encryption.
- Store the release certificate in `Cert:\CurrentUser\My`, which is the store
  used by the Tauri Windows signer. Restrict private-key access to the release
  operator.
- Use the timestamp service supplied by the certificate authority. The release
  script requires every project-owned artifact to have both an approved
  publisher signature and a trusted timestamp.
- Restrict the GitHub `windows-release` environment to approved reviewers. The
  workflow accepts only a tag or the repository default branch.

## Local signed release

Install the production certificate in a supported Windows certificate store,
then obtain its thumbprint without exporting the private key:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Select-Object Subject, Thumbprint, NotAfter, HasPrivateKey
```

Run the release orchestrator from the repository root:

```powershell
npm run desktop:release:windows -- `
  -ExpectedPublisherThumbprint '<PRODUCTION_CERTIFICATE_THUMBPRINT>' `
  -TimestampUrl '<CERTIFICATE_AUTHORITY_TIMESTAMP_URL>'
```

The orchestrator performs these steps as one fail-closed operation:

1. Validates the certificate, private key, validity period, and Code Signing EKU.
2. Builds the frontend, runtime service, and Isaac data-plane.
3. Signs and timestamps the service and Isaac before runtime staging.
4. Gives Tauri an ephemeral signing configuration for the Desktop and NSIS build.
5. Verifies the publisher and timestamp on every project-owned release artifact.
6. Verifies the vendor signature on the bundled Node runtime.
7. Writes a SHA-256 checksum beside the verified NSIS installer.

The ephemeral Tauri signing configuration is removed even if the build fails.
The script exits non-zero and produces no approved release when any gate fails.

## GitHub Actions configuration

The manual `Windows signed release` workflow uses the protected
`windows-release` environment. Configure these repository environment values:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `SCAMATIC_WINDOWS_PUBLISHER_THUMBPRINT` | Approved certificate thumbprint |
| Variable | `SCAMATIC_WINDOWS_TIMESTAMP_URL` | Certificate authority timestamp URL |
| Secret | `SCAMATIC_WINDOWS_CERTIFICATE_BASE64` | Base64 representation of the PFX bytes |
| Secret | `SCAMATIC_WINDOWS_CERTIFICATE_PASSWORD` | PFX export password |

Create the Base64 value locally without adding either output file to the
repository:

```powershell
$certificateBytes = [IO.File]::ReadAllBytes('<PATH_TO_CERTIFICATE_PFX>')
[Convert]::ToBase64String($certificateBytes) | Set-Clipboard
```

Trigger the workflow manually. It imports the certificate into the ephemeral
runner, invokes the same fail-closed release orchestrator, uploads only the
verified installer and checksum, and removes the imported certificate and PFX
file in an `always()` cleanup step before the artifact uploader runs. All
third-party workflow actions are pinned to exact reviewed commit SHAs, checkout
credentials are not persisted, and dependency caching is disabled for this
privileged job.

## Release acceptance

Download the workflow artifact onto a clean Windows test VM and verify its
checksum. Install it interactively, then run:

```powershell
npm run desktop:verify-install -- `
  -RequireSignature `
  -InstallerPath '<PATH_TO_DOWNLOADED_INSTALLER>' `
  -ExpectedPublisherThumbprint '<PRODUCTION_CERTIFICATE_THUMBPRINT>'
```

The installation is releasable only after that command passes before and after
a Windows reboot. This final check covers the installed service, Desktop,
uninstaller, Isaac, Node runtime, loopback listener ownership, runtime ACLs,
data-plane readiness, and master-key compatibility.
