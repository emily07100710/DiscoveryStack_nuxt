export const FRAPPE_SYSTEM_FACTORY_PROVENANCE = {
  registryVersion: 'frappe-system-factory-provenance-v1',
  retrievedAt: '2026-08-29T00:00:00.000Z',
  supportBranch: 'version-16',
  frappe: { repository: 'https://github.com/frappe/frappe.git', tag: 'v16.32.0', commit: '5cba016e86b54b57f34a3864282b92300ef20fb0', license: 'MIT', licenseSha256: 'bc6001a54ffcc4ab520424d7dbb85b293578efcdcb7d8f8055e00dddf942e5d7' },
  erpnext: { repository: 'https://github.com/frappe/erpnext.git', tag: 'v16.33.0', commit: 'b24c9eba551905e256e336ff170a91a92d197a2f', license: 'GPL-3.0-only', licenseSha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986' },
  legacyBaseImage: { reference: 'docker.io/frappe/erpnext:v16.33.0', digest: 'sha256:493cecf82c92c828bf0d0c57df60694e07dc61671e374ac93a070d1cc86df1bd', productionRuntimeAuthority: false },
  projectImage: { customAppSha256: '4db2698b4c5730c5650d52daab66bfb8c31edd615280e7051295699688590ec3', buildRecipeFingerprint: 'dabf5882d47dc5cc1fa7487aa753d589b223d225ec38a6d4434e78d5769c4257', imageManifestDigest: 'sha256:537d0a332716541df27a96c906c8ff90ca69574b6b35bb64599926d6ff4ec6e2', imageConfigDigest: 'sha256:7b8e808d7ba13fb97963cad4ca6e71f9c1ce129d27d220b309020a21373e899f', productionApproved: false, status: 'LOCAL_IMAGE_AUTHORITY_VERIFIED_PRODUCTION_UNAPPROVED' },
  compatibility: { systemSpec: 'system-spec-v1', compiler: 'system-spec-compiler-v2', frappeApp: '0.1.0', nuxtAdapter: 'frappe-system-factory-v1' },
  endorsement: false,
  distributionReviewRequired: true,
} as const
