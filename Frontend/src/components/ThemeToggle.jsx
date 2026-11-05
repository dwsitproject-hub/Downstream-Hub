import { useTheme } from '../context/ThemeContext';
import { Icon } from './HubIcons';

/** Sun / moon button that switches the Hub between light and dark mode. */
export default function ThemeToggle({ style }) {
  const { theme, toggleTheme } = useTheme();
  const toDark = theme !== 'dark';
  const label = toDark ? 'Switch to dark mode' : 'Switch to light mode';
  return (
    <button type="button" className="hub-icon-btn" onClick={toggleTheme} aria-label={label} title={label} style={style}>
      <Icon name={toDark ? 'moon' : 'sun'} size={19} />
    </button>
  );
}
