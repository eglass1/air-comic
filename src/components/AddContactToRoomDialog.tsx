import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Avatar,
  TextField,
  InputAdornment,
  Chip,
  CircularProgress,
  Snackbar,
  Alert,
} from '@mui/material';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import SearchIcon from '@mui/icons-material/Search';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PeopleIcon from '@mui/icons-material/People';
import { useChat } from '../context/ChatContext';
import { Friend } from '../types';

interface AddContactToRoomDialogProps {
  open: boolean;
  onClose: () => void;
  onOpenFriends: () => void;
}

export const AddContactToRoomDialog: React.FC<AddContactToRoomDialogProps> = ({
  open,
  onClose,
  onOpenFriends,
}) => {
  const { friends, participants, proactiveAddFriend, isRekeying } = useChat();
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [addingFriendId, setAddingFriendId] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);

  const approvedIds = new Set(
    participants.filter((p) => p.isApproved).map((p) => p.participantId)
  );

  const filteredFriends = friends.filter((f) => {
    const term = searchTerm.toLowerCase();
    return (
      f.screenName.toLowerCase().includes(term) ||
      (f.contactInfo?.info && f.contactInfo.info.toLowerCase().includes(term)) ||
      (f.notes && f.notes.toLowerCase().includes(term))
    );
  });

  const handleAdd = async (friend: Friend) => {
    setAddingFriendId(friend.id);
    const ok = await proactiveAddFriend(friend);
    setAddingFriendId(null);
    if (ok) {
      setSnack(`Added ${friend.screenName} to conversation!`);
      onClose();
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <PersonAddAlt1Icon color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Add Friend to Conversation
          </Typography>
        </DialogTitle>

        <DialogContent dividers sx={{ minHeight: 320 }}>
          <TextField
            placeholder="Search contacts by name, info, notes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            fullWidth
            size="small"
            sx={{ mb: 2 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="action" />
                  </InputAdornment>
                ),
              },
            }}
          />

          {friends.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
              <Typography variant="body2">No contacts saved in your friends directory yet.</Typography>
            </Box>
          ) : filteredFriends.length === 0 ? (
            <Typography sx={{ py: 3, textAlign: 'center', color: 'text.secondary' }}>
              No contacts matched "{searchTerm}"
            </Typography>
          ) : (
            <List sx={{ pt: 0 }}>
              {filteredFriends.map((f) => {
                const isAlreadyIn = approvedIds.has(f.participantId);

                return (
                  <ListItem
                    key={f.id}
                    sx={{
                      mb: 1,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 2,
                      bgcolor: 'background.paper',
                    }}
                  >
                    <ListItemAvatar>
                      <Avatar sx={{ bgcolor: 'secondary.main', color: '#fff', fontWeight: 'bold' }}>
                        {f.screenName.charAt(0).toUpperCase()}
                      </Avatar>
                    </ListItemAvatar>

                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                            {f.screenName}
                          </Typography>
                        </Box>
                      }
                      secondary={
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                          {f.contactInfo?.info || f.notes || `ID: ${f.participantId.slice(0, 16)}...`}
                        </Typography>
                      }
                    />

                    {isAlreadyIn ? (
                      <Chip
                        icon={<CheckCircleIcon sx={{ fontSize: '14px !important' }} />}
                        label="Already in Room"
                        color="success"
                        variant="outlined"
                        size="small"
                      />
                    ) : (
                      <Button
                        variant="contained"
                        size="small"
                        color="primary"
                        onClick={() => handleAdd(f)}
                        disabled={isRekeying || addingFriendId === f.id}
                        startIcon={addingFriendId === f.id ? <CircularProgress size={14} color="inherit" /> : <PersonAddAlt1Icon />}
                      >
                        Add to Room
                      </Button>
                    )}
                  </ListItem>
                );
              })}
            </List>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5, justifyContent: 'space-between' }}>
          <Button
            size="small"
            onClick={() => {
              onClose();
              onOpenFriends();
            }}
          >
            Manage Friends Directory
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snack)}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSnack(null)} severity="success" sx={{ width: '100%' }}>
          {snack}
        </Alert>
      </Snackbar>
    </>
  );
};
