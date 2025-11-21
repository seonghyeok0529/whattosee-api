export function isAdminEmail(email?: string | null): boolean {
    if (!email) return false;
    const raw = process.env.ADMIN_EMAILS ?? "";
    const list = raw.split(",").map(s => s.trim()).filter(Boolean);
    return list.includes(email);
  }
  