import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { createEntity } from '../api/client';
import { LoadingSpinner } from '../components/loading-spinner';
import { RecordForm } from '../components/record-form';
import { useMetadata } from '../hooks/use-metadata';
import { useUiConfig } from '../hooks/use-ui-config';
import { useServer } from '../context/server-context';

/** Page for creating a new record. */
export const AddPage = () => {
  const { resource } = useParams<{ resource: string }>();
  const navigate = useNavigate();
  const { resources, isLoadingResources, permissions } = useServer();
  const resourceName = resource ?? '';

  const [isSubmitting, setIsSubmitting] = useState(false);
  const { fields, lookups, isLoading: metaLoading } = useMetadata(resourceName);
  const { fieldGroups } = useUiConfig();

  const handleSubmit = useCallback(
    async (values: Record<string, unknown>) => {
      setIsSubmitting(true);
      try {
        await createEntity(resourceName, values);
        navigate(`/${resourceName}`);
      } finally {
        setIsSubmitting(false);
      }
    },
    [resourceName, navigate]
  );

  // Validate resource exists (after all hooks)
  const isValidResource = resources?.some(r => r.name === resourceName) ?? null;
  if (isLoadingResources || isValidResource === null || metaLoading) {
    return <LoadingSpinner />;
  }
  if (!isValidResource) {
    return <div className="p-4 sm:p-6 text-red-600 dark:text-red-400">Unknown resource: {resource}</div>;
  }
  if (!permissions.canAdd) {
    return (
      <div className="p-4 sm:p-6 text-sm text-gray-500 dark:text-gray-400">
        This server does not support adding records.{' '}
        <button type="button" onClick={() => navigate(`/${resourceName}`)} className="text-blue-600 hover:text-blue-800">
          Back to {resourceName}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Pinned header */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <button type="button" onClick={() => navigate(`/${resourceName}`)} className="text-sm text-blue-600 hover:text-blue-800 mb-1">
          &larr; Back to {resourceName}
        </button>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Add {resourceName}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Create a new {resourceName} record. The key will be auto-generated.
        </p>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 sm:px-6 pt-4">
        <RecordForm
          resource={resourceName}
          fields={fields}
          lookups={lookups}
          fieldGroups={fieldGroups}
          onSubmit={handleSubmit}
          isLoading={isSubmitting}
        />
      </div>
    </div>
  );
};
