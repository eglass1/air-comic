import React, { useState } from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Button,
  Box,
  Tooltip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Badge,
  CircularProgress,
  Divider,
} from '@mui/material';
import SecurityIcon from '@mui/icons-material/Security';
import PeopleIcon from '@mui/icons-material/People';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import ShareIcon from '@mui/icons-material/Share';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import AutoAwesomeMosaicIcon from '@mui/icons-material/AutoAwesomeMosaic';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import PublicIcon from '@mui/icons-material/Public';
import LockIcon from '@mui/icons-material/Lock';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import InfoIcon from '@mui/icons-material/Info';
import { useChat } from '../context/ChatContext';
import { AboutDialog } from './AboutDialog';

interface NavbarProps {
  themeMode: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenProfile: () => void;
  onOpenFriends: () => void;
  onOpenInvite: () => void;
  onOpenSecurity: () => void;
  onOpenAddContact: () => void;
  onOpenRequests: () => void;
  onOpenPublicRooms: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  themeMode,
  onToggleTheme,
  onOpenProfile,
  onOpenFriends,
  onOpenInvite,
  onOpenSecurity,
  onOpenAddContact,
  onOpenRequests,
  onOpenPublicRooms,
}) => {
  const {
    profile,
    connectionStatus,
    connectedPeersCount,
    activeEpoch,
    isApproved,
    isRekeying,
    pendingJoinRequests,
    claimConversation,
    clearHistory,
    friends,
    roomMode,
    channelTitle,
    zoomLevel,
    setZoomLevel,
  } = useChat();

  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);

  const handleOpenMenu = (event: React.MouseEvent<HTMLElement>) => {
    setMenuAnchor(event.currentTarget);
  };

  const handleCloseMenu = () => {
    setMenuAnchor(null);
  };

  const handleClearHistory = async () => {
    handleCloseMenu();
    if (window.confirm('Clear all stored messages for this conversation from IndexedDB?')) {
      await clearHistory();
    }
  };

  return (
    <AppBar
      position="static"
      elevation={0}
      sx={{
        bgcolor: 'background.paper',
        color: 'text.primary',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Toolbar sx={{ justifyContent: 'space-between', gap: 1, minHeight: 60 }}>
        {/* Brand Logo Button (Triggers Main Dropdown Menu) */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Tooltip title="AirComic Main Menu">
            <Box
              onClick={handleOpenMenu}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.2,
                cursor: 'pointer',
                borderRadius: 2,
                p: 0.6,
                pr: 1.2,
                transition: 'background-color 0.15s',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  borderRadius: 2,
                  p: 0.8,
                  boxShadow: '0 0 12px rgba(0, 229, 255, 0.4)',
                }}
              >
                <AutoAwesomeMosaicIcon sx={{ fontSize: 22 }} />
              </Box>

              <Typography
                variant="h6"
                component="span"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  lineHeight: 1,
                  letterSpacing: '-0.3px',
                }}
              >
                <span
                  style={{
                    color: themeMode === 'dark' ? '#38bdf8' : '#0070f3',
                    fontWeight: 800,
                  }}
                >
                  Air
                </span>
                <span
                  style={{
                    color: themeMode === 'dark' ? '#ffffff' : '#000000',
                    fontFamily: '"Comic Sans MS", "Comic Relief", "Comic Neue", "Chalkboard SE", sans-serif',
                    fontWeight: 700,
                  }}
                >
                  Comic
                </span>
              </Typography>
            </Box>
          </Tooltip>

          {/* Room Mode Badge - Circle Icon Bubble */}
          {roomMode === 'public' ? (
            <Tooltip title={`Public Room: "${channelTitle}". Anyone can discover and join from the directory.`}>
              <IconButton
                size="small"
                color="info"
                onClick={onOpenPublicRooms}
                sx={{
                  width: 26,
                  height: 26,
                  bgcolor: 'info.main',
                  color: 'info.contrastText',
                  '&:hover': { bgcolor: 'info.dark' },
                  p: 0,
                }}
              >
                <PublicIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title="Private Encrypted Room. Admission requires approval or key exchange.">
              <IconButton
                size="small"
                color="inherit"
                onClick={onOpenInvite}
                sx={{
                  width: 26,
                  height: 26,
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'action.hover',
                  p: 0,
                }}
              >
                <LockIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}

          {/* Combined Connection & Peers Status Indicator */}
          <Tooltip
            title={
              connectionStatus !== 'connected'
                ? 'Not Connected'
                : connectedPeersCount === 0
                ? 'Connected (no peers)'
                : connectedPeersCount === 1
                ? 'Connected (1 peer)'
                : `Connected (${connectedPeersCount} peers)`
            }
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.5,
                height: 24,
                minWidth: 24,
                px: connectionStatus === 'connected' && connectedPeersCount > 0 ? 0.8 : 0.7,
                borderRadius: 4,
                bgcolor:
                  connectionStatus === 'connected'
                    ? 'rgba(0, 230, 118, 0.12)'
                    : 'rgba(255, 171, 0, 0.12)',
                border: '1px solid',
                borderColor:
                  connectionStatus === 'connected'
                    ? 'rgba(0, 230, 118, 0.3)'
                    : 'rgba(255, 171, 0, 0.3)',
              }}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: connectionStatus === 'connected' ? 'success.main' : 'warning.main',
                  boxShadow:
                    connectionStatus === 'connected'
                      ? '0 0 6px rgba(0, 230, 118, 0.8)'
                      : '0 0 6px rgba(255, 171, 0, 0.8)',
                }}
              />
              {connectionStatus === 'connected' && connectedPeersCount > 0 && (
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    lineHeight: 1,
                    color: 'success.main',
                  }}
                >
                  {connectedPeersCount}
                </Typography>
              )}
            </Box>
          </Tooltip>
        </Box>

        {/* Right Action Icons & Main Dropdown Menu */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
          {/* 1. Invite Friend */}
          {isApproved && (
            <Tooltip title="Invite Friend">
              <IconButton color="inherit" onClick={onOpenAddContact}>
                <PersonAddAlt1Icon />
              </IconButton>
            </Tooltip>
          )}

          {/* 2. Share Invite */}
          <Tooltip title="Share Invite">
            <IconButton color="inherit" onClick={onOpenInvite}>
              <ShareIcon />
            </IconButton>
          </Tooltip>

          {/* Pending Requests Badge */}
          {isApproved && pendingJoinRequests.length > 0 && (
            <Tooltip title={`${pendingJoinRequests.length} pending join request(s)`}>
              <IconButton color="warning" onClick={onOpenRequests}>
                <Badge badgeContent={pendingJoinRequests.length} color="error">
                  <NotificationsActiveIcon />
                </Badge>
              </IconButton>
            </Tooltip>
          )}

          {/* 3. Public Rooms */}
          <Tooltip title="Public Rooms">
            <IconButton color="inherit" onClick={onOpenPublicRooms}>
              <PublicIcon />
            </IconButton>
          </Tooltip>

          {/* 4. Friends (x) */}
          <Tooltip title={`Friends (${friends.length})`}>
            <IconButton color="inherit" onClick={onOpenFriends}>
              <PeopleIcon />
            </IconButton>
          </Tooltip>

          {/* 5. Profile */}
          <Tooltip title="Profile">
            <IconButton color="inherit" onClick={onOpenProfile}>
              <AccountCircleIcon />
            </IconButton>
          </Tooltip>

          {/* 6. Dark/Light Mode */}
          <Tooltip title="Dark/Light Mode">
            <IconButton color="inherit" onClick={onToggleTheme}>
              {themeMode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>

          {/* Main Dropdown Menu (Opened via Logo Button) */}
          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={handleCloseMenu}>
            {/* 1. Invite Friend */}
            {isApproved && (
              <MenuItem onClick={() => { handleCloseMenu(); onOpenAddContact(); }}>
                <ListItemIcon>
                  <PersonAddAlt1Icon fontSize="small" color="primary" />
                </ListItemIcon>
                <ListItemText>Invite Friend</ListItemText>
              </MenuItem>
            )}

            {/* 2. Share Invite */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenInvite(); }}>
              <ListItemIcon>
                <ShareIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Share Invite</ListItemText>
            </MenuItem>

            {/* 3. Public Rooms */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenPublicRooms(); }}>
              <ListItemIcon>
                <PublicIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Public Rooms</ListItemText>
            </MenuItem>

            {/* 4. Friends (x) */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenFriends(); }}>
              <ListItemIcon>
                <PeopleIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Friends ({friends.length})</ListItemText>
            </MenuItem>

            {/* 5. Profile */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenProfile(); }}>
              <ListItemIcon>
                <AccountCircleIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Profile</ListItemText>
            </MenuItem>

            {/* 6. Network/Security */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenSecurity(); }}>
              <ListItemIcon>
                <SecurityIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Network/Security</ListItemText>
            </MenuItem>

            {/* 7. Comic Zoom Control */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                px: 2,
                py: 0.8,
                borderTop: '1px solid',
                borderBottom: '1px solid',
                borderColor: 'divider',
                my: 0.5,
                bgcolor: 'action.hover',
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary', fontSize: '0.8rem' }}>
                Comic Zoom
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoomLevel((z) => Math.max(0.7, Math.round((z - 0.15) * 100) / 100));
                  }}
                  disabled={zoomLevel <= 0.75}
                >
                  <ZoomOutIcon fontSize="small" />
                </IconButton>
                <Typography variant="body2" sx={{ fontWeight: 800, minWidth: 40, textAlign: 'center', fontSize: '0.85rem' }}>
                  {Math.round(zoomLevel * 100)}%
                </Typography>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoomLevel((z) => Math.min(1.5, Math.round((z + 0.15) * 100) / 100));
                  }}
                  disabled={zoomLevel >= 1.45}
                >
                  <ZoomInIcon fontSize="small" />
                </IconButton>
              </Box>
            </Box>

            {/* 8. Dark Mode / Light Mode Toggle */}
            <MenuItem
              onClick={() => {
                handleCloseMenu();
                onToggleTheme();
              }}
            >
              <ListItemIcon>
                {themeMode === 'light' ? (
                  <DarkModeIcon fontSize="small" color="primary" />
                ) : (
                  <LightModeIcon fontSize="small" color="primary" />
                )}
              </ListItemIcon>
              <ListItemText>{themeMode === 'light' ? 'Dark' : 'Light'}</ListItemText>
            </MenuItem>

            {/* Separator for Clear Local Message History */}
            <Divider sx={{ my: 0.5 }} />

            {/* 9. Clear Local Message History */}
            <MenuItem onClick={handleClearHistory} sx={{ color: 'error.main' }}>
              <ListItemIcon>
                <DeleteSweepIcon fontSize="small" color="error" />
              </ListItemIcon>
              <ListItemText>Clear Local Message History</ListItemText>
            </MenuItem>

            <Divider sx={{ my: 0.5 }} />

            {/* 10. About... */}
            <MenuItem
              onClick={() => {
                handleCloseMenu();
                setIsAboutOpen(true);
              }}
            >
              <ListItemIcon>
                <InfoIcon fontSize="small" sx={{ color: '#0070f3' }} />
              </ListItemIcon>
              <ListItemText>About...</ListItemText>
            </MenuItem>
          </Menu>
        </Box>
      </Toolbar>

      {/* About Dialog */}
      <AboutDialog open={isAboutOpen} onClose={() => setIsAboutOpen(false)} />
    </AppBar>
  );
};
