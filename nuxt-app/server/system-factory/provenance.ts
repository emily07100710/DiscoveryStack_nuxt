export const FRAPPE_SYSTEM_FACTORY_PROVENANCE = {
  registryVersion: 'frappe-system-factory-provenance-v1',
  retrievedAt: '2026-08-29T00:00:00.000Z',
  supportBranch: 'version-16',
  frappe: { repository: 'https://github.com/frappe/frappe.git', tag: 'v16.32.0', commit: '5cba016e86b54b57f34a3864282b92300ef20fb0', license: 'MIT', licenseSha256: 'bc6001a54ffcc4ab520424d7dbb85b293578efcdcb7d8f8055e00dddf942e5d7' },
  erpnext: { repository: 'https://github.com/frappe/erpnext.git', tag: 'v16.33.0', commit: 'b24c9eba551905e256e336ff170a91a92d197a2f', license: 'GPL-3.0-only', licenseSha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986' },
  legacyBaseImage: { reference: 'docker.io/frappe/erpnext:v16.33.0', digest: 'sha256:493cecf82c92c828bf0d0c57df60694e07dc61671e374ac93a070d1cc86df1bd', productionRuntimeAuthority: false },
  projectImage: { customAppSha256: 'e2fa36bd04c2eaba39fbc8b74d7e73f51646f882260c694f1958c6ce8a436803', buildRecipeFingerprint: 'dabf5882d47dc5cc1fa7487aa753d589b223d225ec38a6d4434e78d5769c4257', imageManifestDigest: null, imageConfigDigest: null, productionApproved: false, status: 'IMAGE_REBUILD_BLOCKED_DOCKER_DAEMON_UNAVAILABLE' },
  compatibility: { systemSpec: 'system-spec-v1', compiler: 'system-spec-compiler-v2', frappeApp: '0.1.0', nuxtAdapter: 'frappe-system-factory-v1' },
  endorsement: false,
  distributionReviewRequired: true,
} as const
