import React, { useState, useMemo, useEffect } from 'react';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  useMediaQuery,
  Drawer,
  IconButton,
  Fab,
  Badge,
  Snackbar,
  Alert,
  Button,
} from '@mui/material';
import PeopleIcon from '@mui/icons-material/People';
import CloseIcon from '@mui/icons-material/Close';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import { createAppTheme } from './theme';
import { ChatProvider, useChat } from './context/ChatContext';
import { Navbar } from './components/Navbar';
import { TabBar } from './components/TabBar';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { ProfileDialog } from './components/ProfileDialog';
import { FriendsDialog } from './components/FriendsDialog';
import { InviteDialog } from './components/InviteDialog';
import { SecurityDialog } from './components/SecurityDialog';
import { AddContactToRoomDialog } from './components/AddContactToRoomDialog';
import { JoinRequestsDialog } from './components/JoinRequestsDialog';
import { MissingSecretDialog } from './components/MissingSecretDialog';
import { IncomingInviteDialog } from './components/IncomingInviteDialog';
import { PublicRoomsDialog } from './components/PublicRoomsDialog';
import { FavoriteRoomsDialog } from './components/FavoriteRoomsDialog';
import { CreatePublicRoomDialog } from './components/CreatePublicRoomDialog';
import { NewRoomDialog } from './components/NewRoomDialog';
import { QuickMessageDialog } from './components/QuickMessageDialog';
import { IncomingQuickMessageOverlay } from './components/IncomingQuickMessageOverlay';
import { InstallAppDialog } from './components/InstallAppDialog';
import { applyUpdate, usePwaStatus } from './services/pwa';

const AppContent: React.FC = () => {
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>('light');
  const [profileOpen, setProfileOpen] = useState<boolean>(false);
  const [friendsOpen, setFriendsOpen] = useState<boolean>(false);
  const [inviteOpen, setInviteOpen] = useState<boolean>(false);
  const [securityOpen, setSecurityOpen] = useState<boolean>(false);
  const [addContactOpen, setAddContactOpen] = useState<boolean>(false);
  const [requestsOpen, setRequestsOpen] = useState<boolean>(false);
  const [publicRoomsOpen, setPublicRoomsOpen] = useState<boolean>(false);
  const [favoritesOpen, setFavoritesOpen] = useState<boolean>(false);
  const [createPublicOpen, setCreatePublicOpen] = useState<boolean>(false);
  const [newRoomOpen, setNewRoomOpen] = useState<boolean>(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState<boolean>(false);
  const [installOpen, setInstallOpen] = useState<boolean>(false);
  const [updateDismissed, setUpdateDismissed] = useState<boolean>(false);

  const { isApproved, pendingJoinRequests } = useChat();
  const { updateReady } = usePwaStatus();

  const isMobile = useMediaQuery('(max-width:900px)');

  const theme = useMemo(() => createAppTheme(themeMode), [themeMode]);

  // Keep the browser/OS chrome tint (Android status bar, installed title bar)
  // in step with the in-app theme so the app surface reads as one piece.
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', theme.palette.background.paper);
  }, [theme]);

  const toggleTheme = () => {
    setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          // dvh tracks collapsing mobile browser chrome; vh is the fallback.
          height: '100vh',
          '@supports (height: 100dvh)': { height: '100dvh' },
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
          color: 'text.primary',
          overflow: 'hidden',
          // Landscape display cutouts. Top and bottom insets are applied by the
          // navbar and the composer so their own surfaces extend into them.
          pl: 'env(safe-area-inset-left)',
          pr: 'env(safe-area-inset-right)',
        }}
      >
        {/* Navbar */}
        <Navbar
          themeMode={themeMode}
          onToggleTheme={toggleTheme}
          onOpenProfile={() => setProfileOpen(true)}
          onOpenFriends={() => setFriendsOpen(true)}
          onOpenInvite={() => setInviteOpen(true)}
          onOpenSecurity={() => setSecurityOpen(true)}
          onOpenAddContact={() => setAddContactOpen(true)}
          onOpenRequests={() => setRequestsOpen(true)}
          onOpenPublicRooms={() => setPublicRoomsOpen(true)}
          onOpenFavorites={() => setFavoritesOpen(true)}
          onOpenInstall={() => setInstallOpen(true)}
        />

        {/* Multi-Conversation Tab Bar */}
        <TabBar onOpenNewRoomDialog={() => setNewRoomOpen(true)} />

        {/* Main Content Area */}
        <Box sx={{ flexGrow: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
          {/* Desktop Sidebar */}
          {!isMobile && (
            <Sidebar
              onOpenInvite={() => setInviteOpen(true)}
              onOpenSecurity={() => setSecurityOpen(true)}
              onOpenFriends={() => setFriendsOpen(true)}
              onOpenAddContact={() => setAddContactOpen(true)}
            />
          )}

          {/* Mobile Sidebar Drawer */}
          {isMobile && (
            <Drawer
              anchor="left"
              open={mobileDrawerOpen}
              onClose={() => setMobileDrawerOpen(false)}
              slotProps={{
                paper: {
                  sx: {
                    width: 310,
                    bgcolor: 'background.paper',
                    pt: 'env(safe-area-inset-top)',
                    pb: 'env(safe-area-inset-bottom)',
                    pl: 'env(safe-area-inset-left)',
                  },
                },
              }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 1 }}>
                <IconButton onClick={() => setMobileDrawerOpen(false)}>
                  <CloseIcon />
                </IconButton>
              </Box>
              <Sidebar
                onOpenInvite={() => { setMobileDrawerOpen(false); setInviteOpen(true); }}
                onOpenSecurity={() => { setMobileDrawerOpen(false); setSecurityOpen(true); }}
                onOpenFriends={() => { setMobileDrawerOpen(false); setFriendsOpen(true); }}
                onOpenAddContact={() => { setMobileDrawerOpen(false); setAddContactOpen(true); }}
              />
            </Drawer>
          )}

          {/* Chat Conversation Area */}
          <ChatArea
            onOpenInvite={() => setInviteOpen(true)}
            onOpenSecurity={() => setSecurityOpen(true)}
            onOpenRequests={() => setRequestsOpen(true)}
            onOpenPublicRooms={() => setPublicRoomsOpen(true)}
          />

          {/* Mobile Floating Participants Button */}
          {isMobile && (
            <Fab
              size="small"
              color="secondary"
              onClick={() => setMobileDrawerOpen(true)}
              sx={{ position: 'absolute', top: 12, left: 12, zIndex: 5 }}
            >
              <Badge badgeContent={isApproved ? pendingJoinRequests.length : 0} color="error">
                <PeopleIcon fontSize="small" />
              </Badge>
            </Fab>
          )}
        </Box>

        {/* Modals & Dialogs */}
        <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
        <FriendsDialog open={friendsOpen} onClose={() => setFriendsOpen(false)} />

        <FavoriteRoomsDialog open={favoritesOpen} onClose={() => setFavoritesOpen(false)} />
        <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
        <SecurityDialog open={securityOpen} onClose={() => setSecurityOpen(false)} />
        <AddContactToRoomDialog
          open={addContactOpen}
          onClose={() => setAddContactOpen(false)}
          onOpenFriends={() => {
            setAddContactOpen(false);
            setFriendsOpen(true);
          }}
        />
        <JoinRequestsDialog
          open={requestsOpen}
          onClose={() => setRequestsOpen(false)}
        />
        <PublicRoomsDialog
          open={publicRoomsOpen}
          onClose={() => setPublicRoomsOpen(false)}
        />
        <CreatePublicRoomDialog
          open={createPublicOpen}
          onClose={() => setCreatePublicOpen(false)}
        />
        <NewRoomDialog
          open={newRoomOpen}
          onClose={() => setNewRoomOpen(false)}
          onOpenPublicDirectory={() => setPublicRoomsOpen(true)}
          onOpenCreatePublicRoom={() => setCreatePublicOpen(true)}
        />
        <InstallAppDialog open={installOpen} onClose={() => setInstallOpen(false)} />
        <MissingSecretDialog />
        <IncomingInviteDialog />
        <QuickMessageDialog />
        <IncomingQuickMessageOverlay />

        {/* A newer build is cached and waiting; swapping it in is the user's
            call, and dismissing it must not leave the composer covered. */}
        <Snackbar
          open={updateReady && !updateDismissed}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          sx={{ mb: 'env(safe-area-inset-bottom)' }}
        >
          <Alert
            severity="info"
            variant="filled"
            sx={{ alignItems: 'center' }}
            action={
              <>
                <Button color="inherit" size="small" onClick={applyUpdate} sx={{ fontWeight: 700 }}>
                  Reload
                </Button>
                <IconButton size="small" color="inherit" onClick={() => setUpdateDismissed(true)}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </>
            }
          >
            A new version of AirComic is ready.
          </Alert>
        </Snackbar>
      </Box>
    </ThemeProvider>
  );
};

export const App: React.FC = () => {
  return (
    <ChatProvider>
      <AppContent />
    </ChatProvider>
  );
};

export default App;
