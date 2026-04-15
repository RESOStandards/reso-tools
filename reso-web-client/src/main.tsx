import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router';
import { Layout } from './components/layout';
import { AuthProvider } from './context/auth-context';
import { ServerProvider } from './context/server-context';
import './index.css';
import { AddPage } from './pages/add-page';
import { AdminLayout } from './pages/admin/admin-layout';
import { DataGeneratorPage } from './pages/admin/data-generator-page';
import { CertHomePage } from './pages/cert/cert-home-page';
import { LoginPage } from './pages/cert/login-page';
import { DetailReportPage } from './pages/cert/detail-report-page';
import { OrgSummaryPage } from './pages/cert/org-summary-page';
import { JobsPage } from './pages/cert/jobs-page';
import { DashboardPage } from './pages/cert/dashboard-page';
import { ComparePage } from './pages/cert/compare-page';
import { DeletePage } from './pages/delete-page';
import { ErrorPage } from './pages/error-page';
import { DetailPage } from './pages/detail-page';
import { EditPage } from './pages/edit-page';
import { HomePage } from './pages/home-page';
import { MetadataPage } from './pages/metadata-page';
import { NotFoundPage } from './pages/not-found-page';
import { OrganizationsPage } from './pages/organizations-page';
import { SearchPage } from './pages/search-page';

const router = createBrowserRouter([
  // Login stays outside the Layout — clean centered card, no sidebar.
  { path: '/cert/login', element: <LoginPage /> },

  // Everything else shares the unified Layout with the sidebar. #109
  {
    path: '/',
    element: <Layout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      {
        path: 'admin',
        element: <AdminLayout />,
        children: [
          { index: true, element: <Navigate to="/admin/data-generator" replace /> },
          { path: 'data-generator', element: <DataGeneratorPage /> }
        ]
      },
      { path: 'organizations', element: <OrganizationsPage /> },
      // Cert pages — now inside the Layout with the unified sidebar.
      // The cert-specific header chrome is removed; they inherit the
      // Layout header with the auth pill and theme toggle.
      { path: 'cert', element: <Navigate to="/cert/dashboard" replace /> },
      { path: 'cert/endorsements', element: <CertHomePage /> },
      { path: 'cert/orgs/:uoi', element: <OrgSummaryPage /> },
      { path: 'cert/orgs/:uoi/detail/:endorsementId', element: <DetailReportPage /> },
      { path: 'cert/jobs', element: <JobsPage /> },
      { path: 'cert/dashboard', element: <DashboardPage /> },
      { path: 'cert/compare/:jobId', element: <ComparePage /> },
      { path: 'metadata', element: <MetadataPage /> },
      { path: 'metadata/:resource', element: <MetadataPage /> },
      { path: ':resource', element: <SearchPage /> },
      { path: ':resource/add', element: <AddPage /> },
      { path: ':resource/edit', element: <EditPage /> },
      { path: ':resource/edit/:key', element: <EditPage /> },
      { path: ':resource/delete', element: <DeletePage /> },
      { path: ':resource/:key', element: <DetailPage /> },
      { path: '*', element: <NotFoundPage /> }
    ]
  }
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <ServerProvider>
        <RouterProvider router={router} />
      </ServerProvider>
    </AuthProvider>
  </StrictMode>
);
