import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  Card,
  CardContent,
  CardActionArea,
  Divider,
  Alert,
  Tabs,
  Tab,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import LinkIcon from '@mui/icons-material/Link';
import PublicIcon from '@mui/icons-material/Public';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import { useChat } from '../context/ChatContext';
import { getRandomChannelTitle } from '../utils/channelNameGenerator';

interface NewRoomDialogProps {
  open: boolean;
  onClose: () => void;
  onOpenPublicDirectory: () => void;
  onOpenCreatePublicRoom: () => void;
}

export const NewRoomDialog: React.FC<NewRoomDialogProps> = ({
  open,
  onClose,
  onOpenPublicDirectory,
  onOpenCreatePublicRoom,
}) => {
  const { createPrivateRoomTab, joinRoomByUrlOrSecret } = useChat();

  const [activeTab, setActiveTab] = useState<number>(0);
  const [customTitle, setCustomTitle] = useState<string>('');
  const [joinInput, setJoinInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const handleCreatePrivate = () => {
    const titleToUse = customTitle.trim() || getRandomChannelTitle();
    createPrivateRoomTab(titleToUse);
    setCustomTitle('');
    setError(null);
    onClose();
  };

  const handleJoin = () => {
    if (!joinInput.trim()) {
      setError('Please enter an invite URL, room code, or secret.');
      return;
    }
    const tabId = joinRoomByUrlOrSecret(joinInput);
    if (!tabId) {
      setError('Could not recognize the provided link or secret.');
      return;
    }
    setJoinInput('');
    setError(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{
        paper: {
          sx: { borderRadius: 2 },
        },
      }}
    >
      <DialogTitle sx={{ pb: 1 }}>Start or Join a Conversation</DialogTitle>

      <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 3 }}>
        <Tabs value={activeTab} onChange={(_e, val) => { setActiveTab(val); setError(null); }}>
          <Tab icon={<LockIcon sx={{ fontSize: 18 }} />} iconPosition="start" label="New Private Room" />
          <Tab icon={<LinkIcon sx={{ fontSize: 18 }} />} iconPosition="start" label="Join with Link" />
          <Tab icon={<PublicIcon sx={{ fontSize: 18 }} />} iconPosition="start" label="Public Rooms" />
        </Tabs>
      </Box>

      <DialogContent sx={{ pt: 3 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Tab 0: New Private Room */}
        {activeTab === 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Creates a brand new end-to-end encrypted room with a generated secret and random channel phrase.
            </Typography>

            <TextField
              label="Channel Name (Optional)"
              placeholder={`e.g. "${getRandomChannelTitle()}"`}
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              fullWidth
              size="small"
              helperText="Leave empty to automatically assign a fun time-of-day phrase."
            />

            <Button
              variant="contained"
              color="primary"
              startIcon={<LockIcon />}
              onClick={handleCreatePrivate}
              sx={{ mt: 1, py: 1 }}
            >
              Create Private Room
            </Button>
          </Box>
        )}

        {/* Tab 1: Join with Link */}
        {activeTab === 1 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Paste an AirComic invite link, room code, or private secret to open and join in a new tab.
            </Typography>

            <TextField
              label="Invite URL or Secret"
              placeholder="https://.../?id=...#secret=..."
              value={joinInput}
              onChange={(e) => {
                setJoinInput(e.target.value);
                setError(null);
              }}
              fullWidth
              size="small"
              autoFocus
            />

            <Button
              variant="contained"
              color="primary"
              startIcon={<LinkIcon />}
              onClick={handleJoin}
              disabled={!joinInput.trim()}
              sx={{ mt: 1, py: 1 }}
            >
              Join Conversation
            </Button>
          </Box>
        )}

        {/* Tab 2: Public Rooms */}
        {activeTab === 2 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Discover open community conversations in the decentralized directory or publish your own room.
            </Typography>

            <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', sm: 'row' } }}>
              <Card variant="outlined" sx={{ flex: 1 }}>
                <CardActionArea
                  onClick={() => {
                    onClose();
                    onOpenPublicDirectory();
                  }}
                  sx={{ p: 2, height: '100%' }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <PublicIcon color="info" />
                    <Typography variant="subtitle1" fontWeight={600}>
                      Browse Directory
                    </Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    View active community rooms and join any conversation with one click.
                  </Typography>
                </CardActionArea>
              </Card>

              <Card variant="outlined" sx={{ flex: 1 }}>
                <CardActionArea
                  onClick={() => {
                    onClose();
                    onOpenCreatePublicRoom();
                  }}
                  sx={{ p: 2, height: '100%' }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <AddCircleOutlineIcon color="primary" />
                    <Typography variant="subtitle1" fontWeight={600}>
                      Create Public Room
                    </Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Publish a new room with tags and description to the public directory.
                  </Typography>
                </CardActionArea>
              </Card>
            </Box>
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
};
