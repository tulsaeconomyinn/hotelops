// HotelOps — create-manager edge function
// Admin-only: creates a Supabase Auth user + manager profile row and emails
// the new manager their login from tulsaeconomyinn@gmail.com.
//
// Secrets required (set with `supabase secrets set`):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   GMAIL_USER (tulsaeconomyinn@gmail.com), GMAIL_APP_PASSWORD
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// automatically injected in deployed Supabase Edge Functions; GMAIL_* are not.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.14";

const APP_URL = "https://tulsaeconomyinn.github.io/hotelops/";
const FROM_ADDRESS = "tulsaeconomyinn@gmail.com";

const WORDS = [
  "river", "maple", "cedar", "sunny", "harbor", "meadow", "garden",
  "bridge", "canyon", "prairie", "willow", "comet", "falcon", "ember",
  "grove", "jasper", "kodiak", "lotus", "mesa", "noble",
  "olive", "pilot", "quarry", "ridge", "sable", "tulip", "umbra",
  "vista", "zephyr",
];

function makePassword(): string {
  const digits = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  const word = WORDS[crypto.getRandomValues(new Uint32Array(1))[0] % WORDS.length];
  return `tulsa-${String(digits).padStart(4, "0")}-${word}`;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
  const GMAIL_PASS = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !GMAIL_USER || !GMAIL_PASS) {
    return json(500, { ok: false, error: "Server misconfigured (missing secrets)" });
  }

  // ---- Verify the caller is an admin ----
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !caller) return json(401, { ok: false, error: "Not signed in" });

  const { data: callerProf, error: profErr } = await callerClient
    .from("profiles").select("role, property_id").eq("id", caller.id).single();
  const isAdmin = !!callerProf && (callerProf.role === "admin" || callerProf.property_id === null);
  if (profErr || !isAdmin) return json(403, { ok: false, error: "Admins only" });

  // ---- Validate input ----
  let body: { email?: string; name?: string; property_id?: string; property_ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim();
  // Multi-hotel assignment (2026-10-20): accept property_ids[], with the old
  // single property_id still supported. property_id stays the primary hotel.
  const propertyIds = (Array.isArray(body.property_ids) && body.property_ids.length
    ? body.property_ids
    : (body.property_id ? [body.property_id] : []))
    .map(x => String(x).trim()).filter(Boolean);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { ok: false, error: "A valid email address is required" });
  }
  if (!propertyIds.length) return json(400, { ok: false, error: "At least one hotel assignment is required" });

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- Confirm the hotels exist (for the welcome email) ----
  const { data: propRows } = await svc.from("properties").select("id, name").in("id", propertyIds);
  if (!propRows || propRows.length !== propertyIds.length) {
    return json(400, { ok: false, error: "Unknown hotel in the assignment list" });
  }
  const hotelNames = propertyIds.map(id => (propRows.find(r => r.id === id)?.name ?? "")).filter(Boolean);

  const password = makePassword();

  // ---- Create the auth user ----
  const { data: newUser, error: createErr } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: name || null },
  });
  if (createErr || !newUser.user) {
    const msg = /already/.test(createErr?.message ?? "")
      ? "A login with this email already exists"
      : (createErr?.message ?? "Could not create the user");
    return json(400, { ok: false, error: msg });
  }
  const userId = newUser.user.id;

  const rollback = async () => {
    await svc.auth.admin.deleteUser(userId).catch(() => {});
    await svc.from("profiles").delete().eq("id", userId).catch(() => {});
  };

  // ---- Upsert the manager profile row ----
  const { error: profUpsertErr } = await svc.from("profiles").upsert({
    id: userId, email, name: name || null, role: "manager",
    property_id: propertyIds[0], property_ids: propertyIds,
  }, { onConflict: "id" });
  if (profUpsertErr) {
    await rollback();
    return json(500, { ok: false, error: "Created the login but could not link the hotel(s): " + profUpsertErr.message });
  }

  // ---- Email the login details ----
  const text = [
    `Hi ${name || "there"},`,
    "",
    "You've been set up with a HotelOps login. HotelOps is the room-down tracking",
    "app for your hotel: when a room goes out of service, you log it here so the",
    "whole team (and the owners) can see what's wrong, who's fixing it, and when",
    "it's due back.",
    "",
    ...(hotelNames.length === 1
      ? [`Your assigned hotel: ${hotelNames[0]}`]
      : ["Your assigned hotels:", ...hotelNames.map(n => `  • ${n}`)]),
    `Sign in at: ${APP_URL}`,
    `Username: ${email}`,
    `Temporary password: ${password}`,
    "",
    "How to use it:",
    '  1. Sign in with the email and temporary password above.',
    ...(hotelNames.length > 1
      ? ["     You can switch between your hotels using the hotel menu at the top."]
      : []),
    '  2. Tap the red "🚨 Report room down" button.',
    "  3. Enter the date, room number, what's wrong, when it's due back, and",
    "     who's working on it — then submit. That's it.",
    "",
    "Please change your password after your first sign-in: tap your email at the",
    "top right, then Change password.",
    "",
    "Reply to this email if you have any questions.",
  ].join("\n");

  try {
    const mailer = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });
    await mailer.sendMail({
      from: `HotelOps <${FROM_ADDRESS}>`,
      to: email,
      subject: "Your HotelOps login",
      text,
    });
  } catch (e) {
    await rollback();
    return json(502, { ok: false, error: "Created the login but could not send the email: " + String(e) });
  }

  return json(200, { ok: true, tempPassword: password });
});
