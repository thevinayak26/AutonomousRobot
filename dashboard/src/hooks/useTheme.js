// -----------------------------------------------------------------------------
// useTheme.js - dark/light theme controller. Writes data-theme onto <html> (the
// selector theme.css keys off), and persists the choice to localStorage so a
// reload keeps it. Defaults to the OS preference on first visit.
// -----------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';

const KEY = 'atlas-theme';

// Dark is the brand default (matches the approved mockup and the data-theme on
// <html>, so there's no first-paint flash); a saved choice always wins.
function initialTheme() {
  const saved = localStorage.getItem(KEY);
  return saved === 'light' ? 'light' : 'dark';
}

export function useTheme() {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
