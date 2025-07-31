import React, { createContext, useContext, useState } from 'react';

interface NotificationContextType {
    notification: string | null;
    showNotification: (message: string) => void;
    clearNotification: () => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [notification, setNotification] = useState<string | null>(null);

    const showNotification = (message: string) => {
        setNotification(message);
        setTimeout(() => {
            setNotification(null);
        }, 3000); // Clear after 3 seconds
    };

    const clearNotification = () => {
        setNotification(null);
    };

    return (
        <NotificationContext.Provider value={{ notification, showNotification, clearNotification }}>
            {children}
        </NotificationContext.Provider>
    );
};

export const useNotification = () => {
    const context = useContext(NotificationContext);
    if (!context) {
        throw new Error("useNotification must be used within a NotificationProvider");
    }
    return context;
};


/* src/NotificationContext.tsx */