import { supabase } from "../../supabaseClient";

export interface DuviaMessage {
  id: string;
  family_id: string;
  sender_id: string;
  sender_name: string | null;
  recipient_ids: string[];
  content: string;
  read_by: string[];
  created_at: string;
}

export async function listMessages(familyId: string): Promise<DuviaMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("family_id", familyId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function sendMessage(params: {
  familyId: string;
  senderId: string;
  senderName: string;
  recipientIds: string[];
  content: string;
}): Promise<DuviaMessage> {
  const { familyId, senderId, senderName, recipientIds, content } = params;
  const { data, error } = await supabase
    .from("messages")
    .insert({
      family_id: familyId,
      sender_id: senderId,
      sender_name: senderName,
      recipient_ids: recipientIds,
      content,
      read_by: [senderId],
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function markMessageRead(id: string, userId: string, currentReadBy: string[]): Promise<void> {
  if (currentReadBy.includes(userId)) return;
  const { error } = await supabase
    .from("messages")
    .update({ read_by: [...currentReadBy, userId] })
    .eq("id", id);
  if (error) throw error;
}
