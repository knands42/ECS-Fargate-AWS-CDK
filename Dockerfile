FROM python:3.10-slim

WORKDIR /app

COPY app/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application
COPY app/app.py ./

# Expose the application on port 8080
EXPOSE 8080

# Command to run the application
CMD ["python", "app.py"]
