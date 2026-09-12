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
    chatPlus: <><path d="M5 5h14v11H9l-4 3z" /><path d="M12 8v5M9.5 10.5h5" /></>,
    folderIn: <><path d="M3.5 6.5h6l2 2h9v10a2 2 0 0 1-2 2h-15z" /><path d="m9 13 3 3 3-3M12 10v6" /></>,
    upload: <><path d="M5 16.5v2h14v-2M12 16V5m-4 4 4-4 4 4" /></>,
    sparkles: <><path d="m12 3 1.2 3.2L16.5 7.5l-3.3 1.3L12 12l-1.2-3.2-3.3-1.3 3.3-1.3zM18.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7zM6 14l.9 2.1L9 17l-2.1.9L6 20l-.9-2.1L3 17l2.1-.9z" /></>,
    search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5" /></>,
    chevronDown: <><path d="m6 9 6 6 6-6" /></>,
    download: <><path d="M5 19h14M12 4v11m-4-4 4 4 4-4" /></>,
    maximize: <><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4" /></>,
    shield: <><path d="M12 3 5.5 6v5.5c0 4.2 2.6 7.4 6.5 9.5 3.9-2.1 6.5-5.3 6.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></>,
    paperclip: <><path d="m9.5 12.5 5.2-5.2a3 3 0 0 1 4.2 4.2l-6.6 6.6a5 5 0 0 1-7.1-7.1l6.4-6.4" /></>,
    arrowUp: <><path d="M12 19V5m-6 6 6-6 6 6" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.7-4.3L3 10M4 13a8 8 0 0 0 14.7 4.3L21 14" /><path d="M3 5v5h5M21 19v-5h-5" /></>,
    back: <><path d="m11 5-7 7 7 7M4 12h16" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
