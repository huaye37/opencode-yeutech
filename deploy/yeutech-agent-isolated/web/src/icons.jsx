export function Icon({ name, size = 18 }) {
  const paths = {
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    folder: <><path d="M3.5 6.5h6l2 2h9v10a2 2 0 0 1-2 2h-15z" /></>,
    chat: <><path d="M5 5h14v11H9l-4 3z" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    send: <><path d="m4 5 16 7-16 7 3-7zM7 12h8" /></>,
    stop: <><rect x="7" y="7" width="10" height="10" rx="1" /></>,
    check: <><path d="m7 12 3 3 7-7" /></>,
    chevron: <><path d="m9 6 6 6-6 6" /></>,
    panel: <><path d="M5 5h14v14H5zM14 5v14" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
