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
  useTheme,
  useMediaQuery,
} from '@mui/material';
import SecurityIcon from '@mui/icons-material/Security';
import PeopleIcon from '@mui/icons-material/People';
import FavoriteIcon from '@mui/icons-material/Favorite';
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
import InstallMobileIcon from '@mui/icons-material/InstallMobile';
import { useChat } from '../context/ChatContext';
import { usePwaStatus } from '../services/pwa';
import { AboutDialog } from './AboutDialog';

type LinkState = 'success' | 'warning' | 'error';

/** RGB triples matching the palette entries the status dot uses. */
const LINK_RGB: Record<LinkState, string> = {
  success: '0, 230, 118',
  warning: '255, 171, 0',
  error: '255, 82, 82',
};

const linkTint = (state: LinkState, alpha: number): string => `rgba(${LINK_RGB[state]}, ${alpha})`;

export interface ConnectionTooltipParams {
  online: boolean;
  connectionStatus: string;
  connectedPeersCount: number;
  pendingSendCount?: number;
  failedSendCount?: number;
}

export const formatConnectionTooltip = ({
  online,
  connectionStatus,
  connectedPeersCount,
  pendingSendCount = 0,
  failedSendCount = 0,
}: ConnectionTooltipParams): string => {
  if (!online) {
    return 'Offline - no network connection';
  }
  if (connectionStatus !== 'connected') {
    return connectionStatus === 'error' ? 'Connection error' : 'Connecting...';
  }
  const base =
    connectedPeersCount > 0
      ? `Connected - ${connectedPeersCount} Direct Connection${connectedPeersCount === 1 ? '' : 's'}`
      : 'Connected';
  const extras = [
    pendingSendCount > 0 ? `${pendingSendCount} sending` : null,
    failedSendCount > 0 ? `${failedSendCount} failed to send` : null,
  ].filter(Boolean);

  return extras.length > 0 ? `${base} | ${extras.join(' | ')}` : base;
};

export interface NavbarProps {
  themeMode: 'dark' | 'light';
  isMobile?: boolean;
  onToggleTheme: () => void;
  onOpenProfile: () => void;
  onOpenFriends: () => void;
  onOpenInvite: () => void;
  onOpenSecurity: () => void;
  onOpenAddContact: () => void;
  onOpenRequests: () => void;
  onOpenPublicRooms: () => void;
  onOpenFavorites: () => void;
  onOpenInstall: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  themeMode,
  isMobile: isMobileProp,
  onToggleTheme,
  onOpenProfile,
  onOpenFriends,
  onOpenInvite,
  onOpenSecurity,
  onOpenAddContact,
  onOpenRequests,
  onOpenPublicRooms,
  onOpenFavorites,
  onOpenInstall,
}) => {
  const theme = useTheme();
  const isMobileBreakpoint = useMediaQuery(theme.breakpoints.down('md'));
  const isMobile = isMobileProp ?? isMobileBreakpoint;

  const {
    profile,
    favoriteRooms,
    connectionStatus,
    connectedPeersCount,
    accelerationStatus,
    pendingSendCount,
    failedSendCount,
    activeEpoch,
    isApproved,
    isRekeying,
    pendingJoinRequests,
    clearHistory,
    friends,
    roomMode,
    channelTitle,
    zoomLevel,
    setZoomLevel,
  } = useChat();

  const { standalone, online } = usePwaStatus();

  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);

  // The device being offline is distinct from the relay mesh not being reachable,
  // and the indicator says which one it is.
  const isLinked = online && connectionStatus === 'connected';
  const linkState: LinkState = !online ? 'error' : isLinked ? 'success' : 'warning';

  const connectionTooltip = formatConnectionTooltip({
    online,
    connectionStatus,
    connectedPeersCount,
    pendingSendCount,
    failedSendCount,
  });

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
        // Extend the bar's own surface under a notch / translucent status bar.
        pt: 'env(safe-area-inset-top)',
        flexShrink: 0,
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
          <Tooltip title={connectionTooltip}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.5,
                height: 24,
                minWidth: 24,
                px: isLinked && connectedPeersCount > 0 ? 0.8 : 0.7,
                borderRadius: 4,
                bgcolor: linkTint(linkState, 0.12),
                border: '1px solid',
                borderColor: linkTint(linkState, 0.3),
              }}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: `${linkState}.main`,
                  boxShadow: `0 0 6px ${linkTint(linkState, 0.8)}`,
                }}
              />
              {isLinked && connectedPeersCount > 0 && (
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

        {/* Right Action Icons (Desktop only - hidden in mobile/phone mode) */}
        {!isMobile && (
          <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 0.8 }}>
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

            {/* 4. Favorite Rooms */}
            <Tooltip title={`Favorite Rooms (${favoriteRooms.length})`}>
              <IconButton color="inherit" onClick={onOpenFavorites}>
                <FavoriteIcon />
              </IconButton>
            </Tooltip>

            {/* 5. Friends */}
            <Tooltip title={`Friends (${friends.length})`}>
              <IconButton color="inherit" onClick={onOpenFriends}>
                <PeopleIcon />
              </IconButton>
            </Tooltip>

            {/* 6. Profile */}
            <Tooltip title="Profile">
              <IconButton color="inherit" onClick={onOpenProfile}>
                <AccountCircleIcon />
              </IconButton>
            </Tooltip>

            {/* 7. Dark/Light Mode */}
            <Tooltip title="Dark/Light Mode">
              <IconButton color="inherit" onClick={onToggleTheme}>
                {themeMode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
              </IconButton>
            </Tooltip>
          </Box>
        )}

        {/* Main Dropdown Menu (Opened via Logo Button) */}
        <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={handleCloseMenu}>
          {/* Join Requests (visible when there are pending requests) */}
          {isApproved && pendingJoinRequests.length > 0 && (
            <MenuItem onClick={() => { handleCloseMenu(); onOpenRequests(); }}>
              <ListItemIcon>
                <Badge badgeContent={pendingJoinRequests.length} color="error">
                  <NotificationsActiveIcon fontSize="small" color="warning" />
                </Badge>
              </ListItemIcon>
              <ListItemText>Join Requests ({pendingJoinRequests.length})</ListItemText>
            </MenuItem>
          )}

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

            {/* 4. Favorite Rooms (x) */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenFavorites(); }}>
              <ListItemIcon>
                <FavoriteIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Favorite Rooms ({favoriteRooms.length})</ListItemText>
            </MenuItem>

            {/* 5. Friends (x) */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenFriends(); }}>
              <ListItemIcon>
                <PeopleIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Friends ({friends.length})</ListItemText>
            </MenuItem>

            {/* 6. Profile */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenProfile(); }}>
              <ListItemIcon>
                <AccountCircleIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Profile</ListItemText>
            </MenuItem>

            {/* 7. Network/Security */}
            <MenuItem onClick={() => { handleCloseMenu(); onOpenSecurity(); }}>
              <ListItemIcon>
                <SecurityIcon fontSize="small" color="primary" />
              </ListItemIcon>
              <ListItemText>Network/Security</ListItemText>
            </MenuItem>

            {/* 8. Comic Zoom Control */}
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

            {/* 9. Install App (hidden once running as an installed app) */}
            {!standalone && (
              <MenuItem onClick={() => { handleCloseMenu(); onOpenInstall(); }}>
                <ListItemIcon>
                  <InstallMobileIcon fontSize="small" color="primary" />
                </ListItemIcon>
                <ListItemText>Install App...</ListItemText>
              </MenuItem>
            )}

            {/* Separator for Clear Local Message History */}
            <Divider sx={{ my: 0.5 }} />

            {/* 10. Clear Local Message History */}
            <MenuItem onClick={handleClearHistory} sx={{ color: 'error.main' }}>
              <ListItemIcon>
                <DeleteSweepIcon fontSize="small" color="error" />
              </ListItemIcon>
              <ListItemText>Clear Local Message History</ListItemText>
            </MenuItem>

            <Divider sx={{ my: 0.5 }} />

            {/* 11. About... */}
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
      </Toolbar>

      {/* About Dialog */}
      <AboutDialog open={isAboutOpen} onClose={() => setIsAboutOpen(false)} />
    </AppBar>
  );
};
