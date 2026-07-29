import { supabase } from "../../supabaseClient";

export async function recordLegalConsent(noticeVersion: string): Promise<void> {
  const { error } = await supabase.rpc("record_legal_consent", { p_notice_version: noticeVersion });
  if (error) throw error;
}
