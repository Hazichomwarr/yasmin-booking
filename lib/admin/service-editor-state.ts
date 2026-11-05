export type ServiceEditorVariantDraft = {
  id?: string;
  name: string;
  description: string;
  price: string;
  isActive: boolean;
  sortOrder: string;
};

export type ServiceEditorDraftState = {
  name: string;
  categoryId: string;
  description: string;
  pricingMode: "simple" | "variants";
  price: string;
  variants: ServiceEditorVariantDraft[];
  removedVariantIds: string[];
  isActive: boolean;
  displayOrder: string;
  newCategoryName: string;
};

function comparableState(state: ServiceEditorDraftState) {
  return {
    ...state,
    variants: state.variants.map(({ id, name, description, price, isActive, sortOrder }) => ({
      id: id ?? null,
      name,
      description,
      price,
      isActive,
      sortOrder,
    })),
    removedVariantIds: [...state.removedVariantIds].sort(),
  };
}

export function serviceEditorStateHasChanges(
  current: ServiceEditorDraftState,
  initial: ServiceEditorDraftState,
): boolean {
  return JSON.stringify(comparableState(current)) !== JSON.stringify(comparableState(initial));
}
