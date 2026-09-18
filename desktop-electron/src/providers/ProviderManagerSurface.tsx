// Compatibility export retained so existing imports and focused contracts keep a stable path.
// The production implementation lives in ProviderHubIntegration, which owns navigation,
// localization, multi-account state, and global proxy management.
export { ProviderManagerSurface } from "./ProviderHubIntegration";
