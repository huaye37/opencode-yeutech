function fileSpaceKey(space) {
  return space?.session ? "standalone" : `project:${space?.project || ""}`;
}

export function removeDeletedAttachmentReferences(attachments, deleted) {
  const deletedWorkspacePath = deleted?.workspacePath;
  const deletedSpace = fileSpaceKey(deleted?.space);
  return attachments.filter((item) => {
    if (deletedWorkspacePath && item?.workspacePath === deletedWorkspacePath) return false;
    return !(item?.path === deleted?.path && fileSpaceKey(item?.space) === deletedSpace);
  });
}

export function removeDeletedUploadStatuses(uploads, deletedPath) {
  return uploads.filter((item) => item?.path !== deletedPath);
}
