import { List } from '@phosphor-icons/react';
import { isMobileDevice } from '../../lib/platform';
import { ui } from '../../store/ui';
export { DeafIcon } from '../Sidebar';

export function MobileMenuButtonInline() {
  if (!isMobileDevice && window.innerWidth > 760) return null;
  return (
    <button className="stage-menu" aria-label="Open menu" onClick={() => ui.setMobilePane('nav')}>
      <List size={22} />
    </button>
  );
}
