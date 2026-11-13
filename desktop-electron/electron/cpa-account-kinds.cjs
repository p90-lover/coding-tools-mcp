"use strict";

// CPA loads one plugin, Provider Manager, so the accounts of the former provider plugins (Cline Pass,
// CommandCode Go, CommandCode, Grok) are provider-manager auth files with a "kind", and CPA's
// auth-file listing shows them all as provider-manager. Provider Manager names each file's kind, and
// a kind's name is the provider id its plugin had, so callers keep telling accounts apart by provider.
const ACCOUNT_KINDS_PATH = "/v0/management/cpa-provider-manager/api/kinds";

const managedFile = (file) => file?.provider === "provider-manager" || file?.type === "provider-manager";

/**
 * The listing with each kind's account under its kind's provider id (and `kind` set). `fetchKinds`
 * resolves to Provider Manager's `{ files: { <auth file name>: <kind> } }`; it is asked only when the
 * listing has a provider-manager file, and a failure leaves the listing as it was.
 */
async function withAccountKinds(listing, fetchKinds) {
  const files = Array.isArray(listing?.files) ? listing.files : null;
  if (!files || !files.some(managedFile)) return listing;
  let kinds = {};
  try {
    const body = await fetchKinds();
    if (body?.files && typeof body.files === "object") kinds = body.files;
  } catch {}
  return {
    ...listing,
    files: files.map((file) => {
      const kind = managedFile(file) && typeof kinds[file?.name] === "string" ? kinds[file.name] : null;
      return kind ? { ...file, provider: kind, type: kind, kind } : file;
    }),
  };
}

module.exports = { ACCOUNT_KINDS_PATH, withAccountKinds };
