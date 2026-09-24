param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ExpectedPublisher
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 2 }
$publisher = $signature.SignerCertificate.GetNameInfo(
  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
if (-not [string]::Equals($publisher, $ExpectedPublisher, [StringComparison]::Ordinal)) { exit 3 }
exit 0
