import { cn } from "@/lib/utils";

/** Lightweight strength estimate for UX feedback only; the server enforces policy. */
export function scorePassword(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (/^(.)\1+$/.test(pw) || /password|123456|qwerty/i.test(pw)) score = Math.min(score, 1);
  return Math.min(score, 4);
}

const LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"];
const COLORS = ["bg-zinc-300", "bg-red-500", "bg-amber-500", "bg-lime-500", "bg-emerald-500"];

export function PasswordStrength({ password }: { password: string }) {
  const score = password.length < 10 ? 0 : Math.max(1, scorePassword(password));
  return (
    <div aria-live="polite" className="space-y-1">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("h-1.5 flex-1 rounded-full bg-muted transition-colors", score >= i && COLORS[score])} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {password ? LABELS[score] : "Use at least 10 characters."}
        {password && password.length < 10 && ` (${10 - password.length} more characters)`}
      </p>
    </div>
  );
}
