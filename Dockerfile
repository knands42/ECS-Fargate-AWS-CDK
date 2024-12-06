FROM python:3.13.1-bullseye as build

WORKDIR /app

COPY app/requirements.txt ./
RUN apt-get -qq update 
RUN pip3 --quiet install --requirement requirements.txt \
         --force-reinstall --upgrade

# Copy the application
COPY app/app.py ./

# Expose the application on port 8080
EXPOSE 8030

# Command to run the application
CMD ["python", "app.py"]
