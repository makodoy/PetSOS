// Cliente Supabase único, configurado a partir de /api/config (variáveis da Vercel).
let clientPromise;
let profilePromise;

export function getClient() {
  if (!clientPromise) {
    clientPromise = fetch("/api/config")
      .then((res) => {
        if (!res.ok) throw new Error("config");
        return res.json();
      })
      .then(({ supabaseUrl, supabaseAnonKey }) => window.supabase.createClient(supabaseUrl, supabaseAnonKey));
  }
  return clientPromise;
}

export async function getSession() {
  const sb = await getClient();
  const { data } = await sb.auth.getSession();
  return data.session;
}

// Perfil do usuário logado ({ id, display_name, role, session }) ou null.
export function getProfile() {
  if (!profilePromise) {
    profilePromise = (async () => {
      const sb = await getClient();
      const session = (await sb.auth.getSession()).data.session;
      if (!session) return null;
      const { data } = await sb.from("profiles").select("id,display_name,role").eq("id", session.user.id).maybeSingle();
      return { id: session.user.id, display_name: data?.display_name ?? "", role: data?.role ?? "user", session };
    })();
  }
  return profilePromise;
}

export const PHOTO_BUCKET = "pet-photos";
export const REPORT_FIELDS =
  "id,user_id,kind,species,custody,pet_name,sex,size,colors,breed,description,photo_path,neighborhood,lat,lng,event_date,status,review_status,review_note,created_at";
