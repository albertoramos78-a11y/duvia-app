import { supabase } from "../../supabaseClient";

export async function recordLegalConsent(noticeVersion: string, source: "fresh" | "backfill"): Promise<void> {
  const { error } = await supabase.rpc("record_legal_consent", { p_notice_version: noticeVersion, p_source: source });
  if (error) throw error;
}
