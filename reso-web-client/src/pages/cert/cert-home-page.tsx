/**
 * Cert Endorsements page — now rendered inside the unified Layout
 * with the sidebar. The header chrome is inherited from Layout;
 * this page is just the EndorsementList content. #109
 */

import { EndorsementList } from '../../components/cert/endorsement-list';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

export const CertHomePage = () => (
  <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
    <EndorsementList containerClassName={PAGE_CONTAINER} />
  </div>
);
