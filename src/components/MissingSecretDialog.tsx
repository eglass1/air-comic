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
  Alert,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import { useChat } from '../context/ChatContext';
import { generateRandomRoomSecret } from '../services/crypto';

export const MissingSecretDialog: React.FC = () => {
  const { isSecretMissing, convId, provideRoomSecret, switchConversation } = useChat();
  const [inputText, setInputText] = useState<string>('');
  const [errorText, setErrorText] = useState<string>('');

  if (!isSecretMissing) return null;

  const handleJoin = () => {
    if (!inputText.trim()) {
      setErrorText('Please enter a room secret or paste a full invite link.');
      return;
    }
    provideRoomSecret(inputText.trim());
  };

  const handleCreateNew = () => {
    switchConversation(crypto.randomUUID(), generateRandomRoomSecret());
  };

  return (
    <Dialog open={isSecretMissing} maxWidth="sm" fullWidth disableEscapeKeyDown>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <LockIcon color="warning" />
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Room Secret Required
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Alert severity="warning">
          You are connecting to conversation <code>{convId.substring(0, 18)}...</code> without a room secret.
          The room secret is required to connect to and decrypt this private conversation.
        </Alert>

        <Typography variant="body2" color="text.secondary">
          Please paste the <strong>Room Secret</strong> or the <strong>Full Invite Link</strong> (which contains <code>#secret=...</code>) shared by the room creator.
        </Typography>

        <TextField
          autoFocus
          label="Paste Room Secret or Full Invite Link"
          placeholder="e.g. yhRHY-WClTy0Pg3waRSmxA or http://localhost:8000/?id=...#secret=..."
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
            setErrorText('');
          }}
          fullWidth
          error={Boolean(errorText)}
          helperText={errorText || 'Pasting a full URL will automatically extract the secret'}
          multiline
          maxRows={3}
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2, justifyContent: 'space-between' }}>
        <Button
          color="inherit"
          startIcon={<AddCircleOutlineIcon />}
          onClick={handleCreateNew}
          size="small"
        >
          Start New Room Instead
        </Button>

        <Button
          variant="contained"
          color="primary"
          startIcon={<MeetingRoomIcon />}
          onClick={handleJoin}
          disabled={!inputText.trim()}
        >
          Connect to Room
        </Button>
      </DialogActions>
    </Dialog>
  );
};
