export const SYSTEM_SPEC_VERSION = 'system-spec-v1' as const
export const SYSTEM_COMPILER_VERSION = 'system-spec-compiler-v2' as const
export const COMPILED_PLAN_VERSION = 'compiled-system-plan-v2' as const
export const MATERIALIZATION_MANIFEST_VERSION = 'system-materialization-manifest-v1' as const

export const SYSTEM_TEMPLATES = ['light_crm', 'appointment_booking', 'membership_course', 'service_project', 'inventory_sales', 'retail_light', 'custom_bounded'] as const
export type SystemTemplateKey = typeof SYSTEM_TEMPLATES[number]

export const SYSTEM_CAPABILITIES = ['crm', 'appointments', 'membership', 'courses', 'projects', 'inventory', 'sales', 'purchasing', 'content_projection', 'geo_aggregate_outcomes'] as const
export type SystemCapability = typeof SYSTEM_CAPABILITIES[number]

export type TemplateDefinition = {
  key: SystemTemplateKey
  label: string
  capabilities: SystemCapability[]
  requiredEntities: string[]
  allowedEntities: string[]
  roles: string[]
  erpNextModules: string[]
  customDocTypes: string[]
  constraints: string[]
  limitations: string[]
}

export const TEMPLATE_CATALOG: Record<SystemTemplateKey, TemplateDefinition> = {
  light_crm: {
    key: 'light_crm', label: 'Light CRM', capabilities: ['crm'], requiredEntities: ['lead', 'customer', 'opportunity'], allowedEntities: ['lead', 'customer', 'opportunity', 'activity', 'note'], roles: ['crm_manager', 'crm_agent', 'crm_viewer'], erpNextModules: ['CRM', 'Selling'], customDocTypes: ['DiscoveryStack Activity'], constraints: ['No custom executable automation.', 'Customer identity remains tenant scoped.'], limitations: ['This template is not a marketing attribution system.'],
  },
  appointment_booking: {
    key: 'appointment_booking', label: 'Appointment booking', capabilities: ['crm', 'appointments'], requiredEntities: ['customer', 'appointment', 'service'], allowedEntities: ['customer', 'appointment', 'service', 'resource', 'availability', 'note'], roles: ['booking_manager', 'booking_staff', 'booking_viewer'], erpNextModules: ['CRM'], customDocTypes: ['DiscoveryStack Appointment', 'DiscoveryStack Service', 'DiscoveryStack Availability'], constraints: ['Availability and timezone are explicit.', 'No provider calendar write without a receipt.'], limitations: ['External calendar and messaging connectors are disabled until configured.'],
  },
  membership_course: {
    key: 'membership_course', label: 'Membership and course', capabilities: ['crm', 'membership', 'courses'], requiredEntities: ['member', 'membership', 'course', 'enrollment'], allowedEntities: ['member', 'membership', 'course', 'enrollment', 'lesson', 'attendance'], roles: ['membership_manager', 'instructor', 'support_viewer'], erpNextModules: ['CRM', 'Education'], customDocTypes: ['DiscoveryStack Membership'], constraints: ['Entitlement is server derived.', 'Payment state is never caller asserted.'], limitations: ['Learning content delivery is outside this operational template.'],
  },
  service_project: {
    key: 'service_project', label: 'Service project', capabilities: ['crm', 'projects'], requiredEntities: ['customer', 'project', 'task'], allowedEntities: ['customer', 'project', 'task', 'timesheet', 'milestone', 'issue'], roles: ['project_manager', 'project_member', 'project_viewer'], erpNextModules: ['Projects', 'CRM'], customDocTypes: ['DiscoveryStack Milestone'], constraints: ['Project/customer relationship is required.', 'Timesheets remain private operational data.'], limitations: ['No payroll or HR entitlement is included.'],
  },
  inventory_sales: {
    key: 'inventory_sales', label: 'Inventory and sales', capabilities: ['crm', 'inventory', 'sales', 'purchasing'], requiredEntities: ['customer', 'item', 'warehouse', 'sales_order'], allowedEntities: ['customer', 'supplier', 'item', 'warehouse', 'sales_order', 'purchase_order', 'stock_entry'], roles: ['inventory_manager', 'sales_user', 'stock_viewer'], erpNextModules: ['Selling', 'Stock', 'Buying'], customDocTypes: [], constraints: ['ERPNext stock ledger remains authoritative.', 'No negative-stock override is generated.'], limitations: ['Accounting localization requires a separate reviewed setup.'],
  },
  retail_light: {
    key: 'retail_light', label: 'Retail light', capabilities: ['crm', 'inventory', 'sales'], requiredEntities: ['customer', 'item', 'warehouse', 'sales_order'], allowedEntities: ['customer', 'item', 'warehouse', 'sales_order', 'payment_reference'], roles: ['retail_manager', 'retail_staff', 'retail_viewer'], erpNextModules: ['Selling', 'Stock'], customDocTypes: ['DiscoveryStack Payment Reference'], constraints: ['DiscoveryStack verified payment receipts are referenced, not recreated.', 'Browser checkout state is never payment authority.'], limitations: ['This is not a point-of-sale payment processor.'],
  },
  custom_bounded: {
    key: 'custom_bounded', label: 'Custom bounded system', capabilities: [], requiredEntities: [], allowedEntities: [], roles: ['system_manager', 'system_user', 'system_viewer'], erpNextModules: [], customDocTypes: [], constraints: ['All entities compile to app-owned DocTypes.', 'No ERPNext core mutation or executable customization.'], limitations: ['A reviewed template expansion is required for regulated or accounting workflows.'],
  },
}

export const RESERVED_DOCTYPES = new Set([
  'doctype', 'docfield', 'user', 'role', 'permission', 'system_settings', 'site_config', 'scheduled_job_type', 'server_script', 'client_script', 'custom_script', 'patch_log', 'installed_application', 'module_def', 'custom_field', 'property_setter', 'workflow_action_master',
])

export function getTemplateCatalogProjection() {
  return SYSTEM_TEMPLATES.map(key => ({ ...TEMPLATE_CATALOG[key] }))
}
