import React, { useState, useMemo } from 'react';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  useMediaQuery,
  Drawer,
  IconButton,
  Fab,
  Badge,
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
import { CreatePublicRoomDialog } from './components/CreatePublicRoomDialog';
import { NewRoomDialog } from './components/NewRoomDialog';

const AppContent: React.FC = () => {
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>('light');
  const [profileOpen, setProfileOpen] = useState<boolean>(false);
  const [friendsOpen, setFriendsOpen] = useState<boolean>(false);
  const [inviteOpen, setInviteOpen] = useState<boolean>(false);
  const [securityOpen, setSecurityOpen] = useState<boolean>(false);
  const [addContactOpen, setAddContactOpen] = useState<boolean>(false);
  const [requestsOpen, setRequestsOpen] = useState<boolean>(false);
  const [publicRoomsOpen, setPublicRoomsOpen] = useState<boolean>(false);
  const [createPublicOpen, setCreatePublicOpen] = useState<boolean>(false);
  const [newRoomOpen, setNewRoomOpen] = useState<boolean>(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState<boolean>(false);

  const { isApproved, pendingJoinRequests } = useChat();

  const isMobile = useMediaQuery('(max-width:900px)');

  const theme = useMemo(() => createAppTheme(themeMode), [themeMode]);

  const toggleTheme = () => {
    setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          height: '100vh',
          width: '100vw',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
          color: 'text.primary',
          overflow: 'hidden',
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
                  sx: { width: 310, bgcolor: 'background.paper' },
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
        <MissingSecretDialog />
        <IncomingInviteDialog />
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
