// The ONE place that says which Supabase projects are ours and which are foreign.
// Imported by both author-time guards so they can never disagree:
//   * scripts/check-migration-grants.mjs  (E6: supabase/migrations/**, comment-aware)
//   * scripts/check-foreign-refs.mjs      (everything else git tracks)
// To deny another project, add its ref to KNOWN_FOREIGN_REFS here; both guards pick it up.

// Production's Supabase project ref (ACADEMY). Any OTHER ref in a Supabase host is foreign infrastructure.
export const PRODUCTION_REF = "cdyidatkegxwhtuoqxly";

// Refs KNOWN to be foreign. These are denied as bare strings, not only inside a URL, so concatenation,
// format() and a ref held in a variable are caught too. wpdztrijasgmxgliwddr is the ORIGINAL
// Lovable-hosted project that production replaced on 2026-07-05: still alive, and not controlled by
// this codebase. Twelve weeks of lesson completions (20260926161000), the sales-intake Google Sheet
// script and a stray import script all kept addressing it after the move.
export const KNOWN_FOREIGN_REFS = ["wpdztrijasgmxgliwddr"];
