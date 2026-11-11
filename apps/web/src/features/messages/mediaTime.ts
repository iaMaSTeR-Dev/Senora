export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const value = Math.floor(seconds);
  const minutes = Math.floor(value / 60) % 60;
  const remainder = String(value % 60).padStart(2,'0');
  return value >= 3600 ? `${Math.floor(value/3600)}:${String(minutes).padStart(2,'0')}:${remainder}` : `${String(minutes).padStart(2,'0')}:${remainder}`;
}
