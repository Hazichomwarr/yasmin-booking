export type CategoryEditableFields = {
  name: string;
  slug: string;
  descriptionText: string;
};

export function categoryDraftHasChanges(
  current: CategoryEditableFields,
  saved: CategoryEditableFields,
): boolean {
  return current.name !== saved.name
    || current.slug !== saved.slug
    || current.descriptionText !== saved.descriptionText;
}

export function newCategoryDraftHasChanges(input: {
  name: string;
  slug: string;
  description: string;
  isActive: boolean;
}): boolean {
  return Boolean(input.name || input.slug || input.description || !input.isActive);
}
