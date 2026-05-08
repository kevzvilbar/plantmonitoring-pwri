import { useState } from 'react';

function useMeterReadingSave(initialValue = null) {
    const [reading, setReading] = useState(initialValue);

    const saveReading = (newReading) => {
        // You can add your logic for saving the reading here
        console.log('Saving the reading:', newReading);
        setReading(newReading);
    };

    return [reading, saveReading];
}

export default useMeterReadingSave;