import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Snackbar,
  Alert,
  InputAdornment,
  IconButton,
  Tooltip,
} from '@mui/material';
import ShareIcon from '@mui/icons-material/Share';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useChat } from '../context/ChatContext';

interface InviteDialogProps {
  open: boolean;
  onClose: () => void;
}

export const InviteDialog: React.FC<InviteDialogProps> = ({ open, onClose }) => {
  const { inviteUrl } = useChat();
  const [snack, setSnack] = useState<string | null>(null);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(inviteUrl);
    setSnack('Invite link copied to clipboard!');
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ShareIcon color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Invite To Conversation
          </Typography>
        </DialogTitle>

        <DialogContent dividers sx={{ pt: 2.5, pb: 2.5 }}>
          <TextField
            label="Shareable Invite Link"
            value={inviteUrl}
            fullWidth
            slotProps={{
              input: {
                readOnly: true,
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title="Copy to Clipboard">
                      <IconButton onClick={handleCopyLink} edge="end" color="primary">
                        <ContentCopyIcon />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ),
                sx: { fontFamily: 'monospace', fontSize: '0.85rem' },
              },
            }}
          />
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button onClick={onClose} variant="contained">
            Close
          </Button>
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
