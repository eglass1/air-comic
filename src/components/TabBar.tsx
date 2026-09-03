import React from 'react';
import {
  Box,
  Tabs,
  Tab,
  IconButton,
  Tooltip,
  Badge,
  Typography,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import PublicIcon from '@mui/icons-material/Public';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import { useChat } from '../context/ChatContext';

interface TabBarProps {
  onOpenNewRoomDialog: () => void;
}

export const TabBar: React.FC<TabBarProps> = ({ onOpenNewRoomDialog }) => {
  const { tabs, activeTabId, switchTab, closeTab } = useChat();

  const handleTabChange = (_event: React.SyntheticEvent, newTabId: string) => {
    if (newTabId !== activeTabId) {
      switchTab(newTabId);
    }
  };

  const handleClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeTab(tabId);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        minHeight: 40,
        maxHeight: 44,
        px: 1,
        overflow: 'hidden',
      }}
    >
      <Tabs
        value={activeTabId || (tabs[0]?.tabId ?? false)}
        onChange={handleTabChange}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{
          flexGrow: 1,
          minHeight: 40,
          '& .MuiTabs-scrollButtons': {
            width: 28,
          },
          '& .MuiTabs-indicator': {
            height: 3,
            borderRadius: '3px 3px 0 0',
          },
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.tabId === activeTabId;
          const isPrivate = tab.roomMode === 'private';

          return (
            <Tab
              key={tab.tabId}
              value={tab.tabId}
              disableRipple
              label={
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    maxWidth: { xs: 150, sm: 220 },
                    textTransform: 'none',
                  }}
                >
                  {/* Room Mode Icon */}
                  {isPrivate ? (
                    <Tooltip title="Private End-to-End Encrypted Room" arrow>
                      <LockIcon
                        sx={{
                          fontSize: 15,
                          color: isActive ? 'primary.main' : 'text.secondary',
                          flexShrink: 0,
                        }}
                      />
                    </Tooltip>
                  ) : (
                    <Tooltip title="Public Room (Discoverable in Directory)" arrow>
                      <PublicIcon
                        sx={{
                          fontSize: 15,
                          color: isActive ? 'info.main' : 'text.secondary',
                          flexShrink: 0,
                        }}
                      />
                    </Tooltip>
                  )}

                  {/* Channel Title */}
                  <Typography
                    variant="body2"
                    noWrap
                    sx={{
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? 'text.primary' : 'text.secondary',
                      fontSize: '0.85rem',
                      lineHeight: 1,
                    }}
                  >
                    {tab.channelTitle || 'AirComic'}
                  </Typography>

                  {/* Unread badge */}
                  {tab.unreadCount > 0 && !isActive && (
                    <Badge
                      badgeContent={tab.unreadCount > 99 ? '99+' : tab.unreadCount}
                      color="error"
                      sx={{
                        '& .MuiBadge-badge': {
                          fontSize: '0.7rem',
                          height: 16,
                          minWidth: 16,
                          px: 0.5,
                        },
                      }}
                    />
                  )}

                  {/* Close Tab Button */}
                  <Tooltip title="Leave Conversation" arrow>
                    <IconButton
                      size="small"
                      onClick={(e) => handleClose(e, tab.tabId)}
                      sx={{
                        p: 0.25,
                        ml: 0.5,
                        opacity: isActive ? 0.7 : 0.4,
                        '&:hover': {
                          opacity: 1,
                          bgcolor: 'action.hover',
                          color: 'error.main',
                        },
                      }}
                    >
                      <CloseIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
              }
              sx={{
                minHeight: 40,
                py: 0.5,
                px: 1.5,
                borderRight: 1,
                borderColor: 'divider',
                bgcolor: isActive ? 'action.selected' : 'transparent',
                '&:hover': {
                  bgcolor: isActive ? 'action.selected' : 'action.hover',
                },
              }}
            />
          );
        })}
      </Tabs>

      {/* Add New Room / Join Button */}
      <Tooltip title="New Conversation / Join Room" arrow>
        <IconButton
          size="small"
          onClick={onOpenNewRoomDialog}
          sx={{
            ml: 1,
            p: 0.75,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            bgcolor: 'action.hover',
            '&:hover': {
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
            },
          }}
        >
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
};
