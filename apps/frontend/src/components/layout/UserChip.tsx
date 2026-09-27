import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { Avatar } from '../ui/Avatar';
import { IconButton } from '../ui/Button';

// Top-header user block required by the assignment: name, email, avatar, logout.
export function UserChip({ compact = false }: { compact?: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <div className="flex items-center gap-2">
      {!compact && (
        <div className="hidden text-right leading-tight lg:block">
          <p className="text-[12px] font-medium text-ink">{user.name ?? user.email}</p>
          <p className="text-[11px] text-muted">{user.email}</p>
        </div>
      )}
      <Avatar src={user.avatarUrl} name={user.name ?? user.email} size={30} />
      <IconButton label="Log out" onClick={() => void logout().then(() => navigate('/login', { replace: true }))}>
        <LogOut className="size-4" />
      </IconButton>
    </div>
  );
}
