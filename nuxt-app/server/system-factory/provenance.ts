export const FRAPPE_SYSTEM_FACTORY_PROVENANCE = {
  registryVersion: 'frappe-system-factory-provenance-v1',
  retrievedAt: '2026-08-29T00:00:00.000Z',
  supportBranch: 'version-16',
  frappe: { repository: 'https://github.com/frappe/frappe.git', tag: 'v16.32.0', commit: '5cba016e86b54b57f34a3864282b92300ef20fb0', license: 'MIT', licenseSha256: 'bc6001a54ffcc4ab520424d7dbb85b293578efcdcb7d8f8055e00dddf942e5d7' },
  erpnext: { repository: 'https://github.com/frappe/erpnext.git', tag: 'v16.33.0', commit: 'b24c9eba551905e256e336ff170a91a92d197a2f', license: 'GPL-3.0-only', licenseSha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986' },
  legacyBaseImage: { reference: 'docker.io/frappe/erpnext:v16.33.0', digest: 'sha256:493cecf82c92c828bf0d0c57df60694e07dc61671e374ac93a070d1cc86df1bd', productionRuntimeAuthority: false },
  projectImage: { customAppSha256: 'cd13356f4b6eb2b38fd0062b6adb24f8b4309e65970cbd4119b84bd689d48369', buildRecipeFingerprint: '81534904f4ea8b9321da267b309fb04099cc27c1893d46e5e091b3d720c52dba', imageManifestDigest: 'sha256:5d5edb656ed098c0fa8ec733347bef70dc81e33267388ad19a84206874e3337d', imageConfigDigest: 'sha256:bb242fa753dbfb109e2418c09db2739edc3195194bb39f7de21139b912c8bef8', productionApproved: false },
  compatibility: { systemSpec: 'system-spec-v1', compiler: 'system-spec-compiler-v1', frappeApp: '0.1.0', nuxtAdapter: 'frappe-system-factory-v1' },
  endorsement: false,
  distributionReviewRequired: true,
} as const
