export interface AnnotationLike {
	file: string;
	virtual?: boolean;
}

export function reconcileWorkspaceAnnotations<T extends AnnotationLike> (
	annotations: T[],
	discoveredFiles: Set<string>,
	taggedFiles: Set<string>
): T[] {
	return annotations.filter ((annotation) =>
		annotation.virtual || (discoveredFiles.has (annotation.file) && taggedFiles.has (annotation.file))
	);
}
