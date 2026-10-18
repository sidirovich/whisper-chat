/** Круглый аватар с первой буквой имени и детерминированным цветом из id. */

function hueFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

export default function Avatar({
  name,
  id,
  size = 34,
  self = false,
}: {
  name: string;
  id: string;
  size?: number;
  self?: boolean;
}) {
  const hue = hueFromId(id);
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      className={`avatar${self ? ' avatar--self' : ''}`}
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: self
          ? 'linear-gradient(135deg, #5b6cff, #8f5cf7)'
          : `hsl(${hue} 42% 34%)`,
      }}
    >
      {letter}
    </span>
  );
}
