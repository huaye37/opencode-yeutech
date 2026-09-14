export function sortSessionsByUpdatedAt(items = []) {
  return [...items].sort((left, right) => {
    const timeDifference = Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0);
    if (timeDifference) return timeDifference;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });
}
