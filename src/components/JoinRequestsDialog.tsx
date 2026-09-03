import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Card,
  CardContent,
  CardActions,
  Avatar,
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  CircularProgress,
  Snackbar,
  Alert,
} from '@mui/material';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import PersonIcon from '@mui/icons-material/Person';
import EmailIcon from '@mui/icons-material/Email';
import PhoneIcon from '@mui/icons-material/Phone';
import HomeIcon from '@mui/icons-material/Home';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import { useChat } from '../context/ChatContext';
import { PendingJoinRequest } from '../types';

interface JoinRequestsDialogProps {
  open: boolean;
  onClose: () => void;
}

export const JoinRequestsDialog: React.FC<JoinRequestsDialogProps> = ({ open, onClose }) => {
  const { pendingJoinRequests, approveJoinRequest, declineJoinRequest, isRekeying } = useChat();
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);

  const handleApprove = async (req: PendingJoinRequest) => {
    setApprovingId(req.requestId);
    const ok = await approveJoinRequest(req);
    setApprovingId(null);
    if (ok) {
      setSnack(`Approved ${req.sender.screenName} and added to contacts!`);
      if (pendingJoinRequests.length <= 1) {
        onClose();
      }
    }
  };

  const handleDecline = (requestId: string, name: string) => {
    declineJoinRequest(requestId);
    setSnack(`Declined request from ${name}`);
    if (pendingJoinRequests.length <= 1) {
      onClose();
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <NotificationsActiveIcon color="warning" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Pending Entry Requests ({pendingJoinRequests.length})
          </Typography>
        </DialogTitle>

        <DialogContent dividers sx={{ minHeight: 250, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {pendingJoinRequests.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
              <CheckCircleIcon sx={{ fontSize: 48, color: 'success.main', mb: 1, opacity: 0.8 }} />
              <Typography variant="subtitle1">No pending entry requests</Typography>
              <Typography variant="caption">
                When new participants connect and request entry, they will appear here for approval.
              </Typography>
            </Box>
          ) : (
            pendingJoinRequests.map((req) => (
              <Card
                key={req.requestId}
                variant="outlined"
                sx={{
                  bgcolor: 'background.default',
                  border: '1px solid',
                  borderColor: 'warning.main',
                  borderRadius: 2,
                }}
              >
                <CardContent sx={{ pb: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
                    <Avatar sx={{ bgcolor: 'warning.main', color: '#000', fontWeight: 'bold' }}>
                      {req.sender.screenName.charAt(0).toUpperCase()}
                    </Avatar>
                    <Box sx={{ flexGrow: 1 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                          {req.sender.screenName}
                        </Typography>
                        <Chip label="Signed Request" size="small" color="success" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        Requested at {new Date(req.timestamp).toLocaleTimeString()}
                      </Typography>
                    </Box>
                  </Box>

                  {/* Contact details / info */}
                  {(req.sender.contactInfo?.info || req.sender.contactInfo?.name) && (
                    <Box sx={{ mt: 1, p: 1, bgcolor: 'background.paper', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', display: 'block', whiteSpace: 'pre-wrap' }}>
                        "{req.sender.contactInfo.info || req.sender.contactInfo.name}"
                      </Typography>
                    </Box>
                  )}

                  <Box sx={{ mt: 1, p: 1, bgcolor: 'background.paper', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontFamily: 'monospace' }}>
                      <VpnKeyIcon sx={{ fontSize: 13 }} /> Key: {req.sender.publicKey.slice(0, 24)}...
                    </Typography>
                  </Box>
                </CardContent>

                <CardActions sx={{ justifyContent: 'flex-end', px: 2, pb: 1.5, gap: 1 }}>
                  <Button
                    size="small"
                    color="inherit"
                    startIcon={<CancelIcon />}
                    onClick={() => handleDecline(req.requestId, req.sender.screenName)}
                    disabled={isRekeying}
                  >
                    Decline
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    color="primary"
                    startIcon={approvingId === req.requestId ? <CircularProgress size={16} color="inherit" /> : <CheckCircleIcon />}
                    onClick={() => handleApprove(req)}
                    disabled={isRekeying}
                  >
                    Approve & Add to Contacts
                  </Button>
                </CardActions>
              </Card>
            ))
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 1.5 }}>
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
