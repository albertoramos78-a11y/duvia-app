import { supabase } from "../../supabaseClient";

export interface ParentLocation {
  city: string;
  lat: number;
  lon: number;
}

export async function getMyLocation(): Promise<ParentLocation | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from("parent_locations")
    .select("city, lat, lon")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export async function setMyLocation(familyId: string, city: string, lat: number, lon: number): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error("not-authenticated");
  const { error } = await supabase.from("parent_locations").upsert({
    user_id: userData.user.id,
    family_id: familyId,
    city,
    lat,
    lon,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function getFamilyWeather(
  familyId: string,
  targetUserId: string,
  date: string
): Promise<{ code: number; tempMax: number; tempMin: number } | null> {
  const { data, error } = await supabase.functions.invoke("get-family-weather", {
    body: { family_id: familyId, target_user_id: targetUserId, date },
  });
  if (error || !data || data.error) return null;
  return data;
}
