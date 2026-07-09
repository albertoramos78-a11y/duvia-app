import { supabase } from "../../supabaseClient";

export interface HiddenConversation {
  convKey: string;
  hiddenAt: string;
}

export async function listHiddenConversations(userId: string): Promise<HiddenConversation[]> {
  const { data, error } = await supabase
    .from("hidden_conversations")
    .select("conv_key, hidden_at")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((row) => ({ convKey: row.conv_key, hiddenAt: row.hidden_at }));
}

/** hidden_at n'est jamais envoyé par le client — un trigger côté serveur (voir
 *  migration 0028) le force toujours à NOW(), y compris sur un ré-masquage. */
export async function hideConversation(userId: string, familyId: string, convKey: string): Promise<string> {
  const { data, error } = await supabase
    .from("hidden_conversations")
    .upsert(
      { user_id: userId, family_id: familyId, conv_key: convKey },
      { onConflict: "user_id,conv_key" }
    )
    .select("hidden_at")
    .single();
  if (error) throw error;
  return data.hidden_at;
}
