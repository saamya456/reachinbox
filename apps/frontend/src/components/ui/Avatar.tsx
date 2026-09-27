import { useState } from 'react';
import { initials } from '../../utils/format';

export function Avatar({
  src,
  name,
  size = 32,
  className = '',
}: {
  src?: string | null;
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) };
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={style}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={style}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-brand font-semibold text-white ${className}`}
    >
      {initials(name)}
    </span>
  );
}
