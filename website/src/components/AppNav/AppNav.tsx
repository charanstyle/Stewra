import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useAuth } from '../../hooks/useAuth';
import styles from './AppNav.module.css';

/** Primary app navigation shared across the authenticated pages (activity, chats, contacts, Stewra). */
export function AppNav(): React.JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    clsx(styles.link, isActive && styles.active);

  return (
    <header className={styles.nav}>
      <div className={styles.left}>
        <span className={styles.brand}>Stewra</span>
        <nav className={styles.links}>
          <NavLink to="/chats" className={linkClass}>
            Chats
          </NavLink>
          <NavLink to="/stewra" className={linkClass}>
            Talk to Stewra
          </NavLink>
          <NavLink to="/contacts" className={linkClass}>
            Contacts
          </NavLink>
          <NavLink to="/activity" className={linkClass}>
            Activity
          </NavLink>
        </nav>
      </div>
      <div className={styles.right}>
        <span className={styles.who}>{user?.displayName}</span>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

export default AppNav;
